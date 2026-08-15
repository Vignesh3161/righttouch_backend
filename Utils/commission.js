import mongoose from "mongoose";
import ServiceCommissionRule from "../Schemas/ServiceCommissionRule.js";
import {
  toPaise,
  rupeesToPaise,
  splitWithCommission,
  assertSplit,
  CALCULATION_VERSION,
} from "./money.js";

/**
 * 📐 COMMISSION ENGINE — server-side, resolve-ONCE, integer paise.
 *
 * Resolution priority (booking creation ONLY):
 *   1. Booking-level Admin override (booking.commissionOverridden === true)
 *   2. Latest active ServiceCommissionRule (effectiveFrom <= now, isActive)
 *   3. Service-level commissionPercentage
 *   4. COMMISSION_DEFAULT_PERCENTAGE env fallback
 *
 * Products: commission = 0 (product commission not enabled).
 *
 * The result is snapshotted onto the ServiceBooking at creation. Payment-order
 * creation, webhook processing, settlement, and withdrawal NEVER recompute it —
 * they copy the booking snapshot (see paymentController.createPaymentOrder).
 */

const getConfig = () => {
  const ceiling = Number(process.env.COMMISSION_MAX_PERCENTAGE);
  const fallback = Number(process.env.COMMISSION_DEFAULT_PERCENTAGE);
  return {
    ceiling: ceiling > 0 && ceiling <= 100 ? ceiling : 60,
    fallback: Number.isFinite(fallback) && fallback >= 0 ? fallback : 0,
  };
};

/**
 * Get the currently-active versioned commission rule for a service.
 * @param {string} serviceId
 * @param {Function} [findRule] injectable rule finder (tests)
 */
export const getActiveCommissionRule = async (serviceId, findRule = null) => {
  if (!mongoose.Types.ObjectId.isValid(serviceId)) return null;
  const finder =
    findRule ||
    ((sid) =>
      ServiceCommissionRule.findOne({
        serviceId: sid,
        isActive: true,
        effectiveFrom: { $lte: new Date() },
      })
        .sort({ effectiveFrom: -1 })
        .lean());
  return (await finder(serviceId)) || null;
};

/**
 * Resolve the authoritative commission snapshot for a booking, in paise.
 * Called ONCE at booking creation (or admin override). NEVER at payment time.
 *
 * @param {object} opts
 * @param {object} opts.booking       booking draft (baseAmountRupees / baseAmountPaise)
 * @param {object} [opts.service]     Service doc
 * @param {number} [opts.tipAmountRupees] tip in rupees (converted to paise)
 * @param {boolean} [opts.isProduct]
 * @param {Function} [opts.findRule]  injectable rule finder (tests)
 *
 * @returns {Promise<{
 *   baseAmountPaise, discountAmountPaise, totalAmountPaise,
 *   gstPercentage, gstAmountPaise, tipAmountPaise,
 *   commissionPercentage, commissionAmountPaise, technicianAmountPaise,
 *   commissionRuleSource, commissionRuleId, calculationVersion,
 *   commissionOverridden, financialSnapshotAt
 * }>}
 */
export const resolveCommissionSnapshot = async ({
  booking = {},
  service = null,
  tipAmountRupees = 0,
  isProduct = false,
  findRule = null,
}) => {
  const { ceiling } = getConfig();

  const baseAmountPaise =
    booking.baseAmountPaise != null
      ? toPaise(booking.baseAmountPaise)
      : rupeesToPaise(booking.baseAmount ?? booking.serviceAmount ?? 0);
  const tipPaise = toPaise(rupeesToPaise(Math.max(Number(tipAmountRupees) || 0, 0)));
  const discountAmountPaise = toPaise(
    booking.discountAmountPaise ?? rupeesToPaise(booking.discountAmount ?? 0)
  );

  let gstPercentage = Number(service?.gstPercentage ?? booking.gstPercentage ?? 0);
  if (!Number.isFinite(gstPercentage) || gstPercentage < 0) gstPercentage = 0;
  const gstAmountPaise = toPaise((baseAmountPaise * gstPercentage) / 100);

  // ── Products: commission hard-zeroed ──
  if (isProduct || booking?.itemType === "product") {
    const totalAmountPaise = toPaise(baseAmountPaise + gstAmountPaise);
    const snapshot = {
      baseAmountPaise,
      discountAmountPaise,
      totalAmountPaise,
      gstPercentage,
      gstAmountPaise,
      tipAmountPaise: 0,
      commissionPercentage: 0,
      commissionAmountPaise: 0,
      technicianAmountPaise: 0,
      commissionRuleSource: "product_zero",
      commissionRuleId: null,
      calculationVersion: CALCULATION_VERSION,
      commissionOverridden: false,
      financialSnapshotAt: new Date(),
    };
    // No assertSplit here: products have NO technician share, so the
    // commission + technician === total invariant does not apply.
    return snapshot;
  }

  // ── Services ──
  const totalBeforeTip = toPaise(baseAmountPaise + gstAmountPaise);
  const totalAmountPaise = toPaise(totalBeforeTip + tipPaise);

  let commissionPercentage = null;
  let ruleSource = null;
  let ruleId = null;
  let overridden = false;

  // 1. Booking-level Admin override
  if (booking.commissionOverridden === true) {
    overridden = true;
    if (booking.commissionAmountPaise != null) {
      commissionPercentage =
        totalBeforeTip > 0 ? (booking.commissionAmountPaise / totalBeforeTip) * 100 : 0;
      ruleSource = "booking_override_amount";
    } else if (booking.commissionPercentage != null) {
      commissionPercentage = Number(booking.commissionPercentage);
      ruleSource = "booking_override_percentage";
    }
    if (commissionPercentage == null) commissionPercentage = 0;
  }

  // 2. Versioned rule
  if (!overridden) {
    const rule = service ? await getActiveCommissionRule(service._id, findRule) : null;
    if (rule) {
      commissionPercentage = Number(rule.commissionPercentage);
      ruleSource = "service_rule";
      ruleId = rule._id;
    } else if (service && Number(service.commissionPercentage) > 0) {
      // 3. Service default
      commissionPercentage = Number(service.commissionPercentage);
      ruleSource = "service_default";
    } else {
      // 4. Global fallback
      commissionPercentage = getConfig().fallback;
      ruleSource = "platform_fallback";
    }
  }

  // Clamp the RATE to the ceiling BEFORE computing money.
  commissionPercentage = Math.min(commissionPercentage || 0, ceiling);

  // NOTE: commission is computed on the service base amount ONLY (before GST
  // and tip) — matching the existing business model: GST is a pass-through to
  // the government and tips go 100% to the technician, so neither ever pays
  // commission. The technician share then absorbs GST + tip.

  let commissionAmountPaise;
  if (overridden && booking.commissionAmountPaise != null) {
    // Exact override amount — used verbatim, never round-tripped through a
    // percentage (percentage is derived for display only).
    commissionAmountPaise = Math.min(toPaise(booking.commissionAmountPaise), baseAmountPaise);
  } else {
    const split = splitWithCommission(baseAmountPaise, commissionPercentage, ceiling);
    if (!split.ok) {
      throw new Error(`commission resolution failed: ${split.error}`);
    }
    commissionAmountPaise = split.commissionAmountPaise;
  }

  const snapshot = {
    baseAmountPaise,
    discountAmountPaise,
    totalAmountPaise,
    gstPercentage,
    gstAmountPaise,
    tipAmountPaise: tipPaise,
    commissionPercentage: Math.round(commissionPercentage * 100) / 100,
    commissionAmountPaise,
    technicianAmountPaise: toPaise(baseAmountPaise + gstAmountPaise + tipPaise - commissionAmountPaise),
    commissionRuleSource: ruleSource,
    commissionRuleId: ruleId,
    calculationVersion: CALCULATION_VERSION,
    commissionOverridden: overridden,
    financialSnapshotAt: new Date(),
  };

  // technicianAmountPaise must satisfy: commission + technician === total
  assertSplit({
    totalAmountPaise,
    commissionAmountPaise: snapshot.commissionAmountPaise,
    technicianAmountPaise: snapshot.technicianAmountPaise,
  });

  return snapshot;
};

/**
 * Sanitize an incoming booking payload: strip every client-submitted monetary
 * field. The server is the ONLY source of money values.
 */
export const stripClientMoneyFields = (payload = {}) => {
  const banned = [
    "commissionPercentage",
    "commissionAmount",
    "commissionAmountPaise",
    "technicianAmount",
    "technicianAmountPaise",
    "totalAmount",
    "totalAmountPaise",
    "platformRevenue",
    "platformRevenuePaise",
    "walletAmount",
    "gstAmount",
    "gstAmountPaise",
  ];
  const out = { ...payload };
  for (const k of banned) delete out[k];
  return out;
};