/**
 * 📐 REWARD REDEMPTION RULES — pure calculation used by preview and reserve.
 *
 * Single source of truth for "how much discount can coins buy".
 * Pure function: no DB, no wallet mutation. The redemption lifecycle and
 * accounting hooks live in Services/rewardService.js; the policy-level
 * redemptionEnabled switch still gates production use.
 *
 * Money model (mirrors earning basis in Services/rewardService.js):
 * - 100 coins = ₹1, i.e. 1 coin == 1 paise of discount. Integer only.
 * - Eligible basis is the service subtotal (`financialSnapshot.baseAmountPaise`).
 *   Tips, GST and catalog discounts are NEVER discountable (see docs).
 * - Discount is platform-funded: technicianAmount / commission unchanged.
 *
 * determine with:
 *   maxRedeemable = min( floor(eligible * maxRedemptionPct / 100),
 *                        availableCoins,
 *                        eligible )
 *   gated by minEligiblePaise (booking) and MIN_REDEEM_COINS (dust guard).
 */

export const COINS_PER_RUPEE = 100;
export const DEFAULT_MIN_REDEEM_COINS = 100; // ₹1 dust guard (proposed default, needs sign-off)

const toNonNegInt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
};

/**
 * Preview the redeemable discount. Never throws for business ineligibility.
 *
 * @param {object} args
 * @param {number} args.eligiblePaise - service subtotal (baseAmountPaise), integer paise
 * @param {number} args.availableCoins - wallet.availableCoins (spendable only; reserved excluded by caller)
 * @param {number} args.maxRedemptionPct - active policy maxRedemptionPct 0..100
 * @param {number} [args.minEligiblePaise=0] - active policy minEligiblePaise
 * @param {number} [args.minRedeemCoins=100] - dust guard (policy field)
 * @param {number|null} [args.totalAmountPaise=null] - gross payment total
 * @param {number} [args.minPayablePaise=100] - keep provider payments >= ₹1
 * @param {number|null} [args.requestedCoins=null] - customer request; null = preview max
 * @returns {{ eligible: boolean, reason: string,
 *   eligiblePaise: number, availableCoins: number,
 *   maxRedeemableCoins: number, redeemCoins: number,
 *   discountPaise: number, discountRupees: number,
 *   payableAfterDiscountPaise: number|null }}
 */
export const calcRedemptionPreview = ({
  eligiblePaise,
  availableCoins,
  maxRedemptionPct,
  minEligiblePaise = 0,
  minRedeemCoins = DEFAULT_MIN_REDEEM_COINS,
  totalAmountPaise = null,
  minPayablePaise = 100,
  requestedCoins = null,
} = {}) => {
  const eligible = toNonNegInt(eligiblePaise);
  const available = toNonNegInt(availableCoins);
  const minEligible = toNonNegInt(minEligiblePaise);
  const minRedeem = toNonNegInt(minRedeemCoins);
  const pct = Number(maxRedemptionPct);

  const base = {
    eligiblePaise: eligible,
    availableCoins: available,
    maxRedeemableCoins: 0,
    redeemCoins: 0,
    discountPaise: 0,
    discountRupees: 0,
    payableAfterDiscountPaise: totalAmountPaise == null ? null : toNonNegInt(totalAmountPaise),
  };

  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ...base, eligible: false, reason: "invalid_maxRedemptionPct" };
  }
  if (eligible <= 0) {
    return { ...base, eligible: false, reason: "invalid_eligible_amount" };
  }
  if (eligible < minEligible) {
    return { ...base, eligible: false, reason: "below_minimum" };
  }
  if (pct === 0) {
    return { ...base, eligible: false, reason: "redemption_capped_zero" };
  }

  // Integer-only cap: floor, never round up (platform never over-discounts).
  const capPct = Math.floor((eligible * pct) / 100);
  let maxRedeemable = Math.max(0, Math.min(capPct, available, eligible));

  // Provider payments must stay >= ₹1. A discount that would leave 1-99
  // paise is trimmed down to the largest valid amount instead of creating a
  // sub-minimum Razorpay order.
  const gross = totalAmountPaise == null ? null : toNonNegInt(totalAmountPaise);
  const minPayable = toNonNegInt(minPayablePaise);
  if (gross != null) {
    if (gross <= minPayable) {
      maxRedeemable = 0;
    } else if (gross - maxRedeemable < minPayable) {
      maxRedeemable = Math.max(0, gross - minPayable);
    }
  }
  const payableAfterDiscountPaise = gross == null ? null : Math.max(0, gross - maxRedeemable);

  if (maxRedeemable <= 0) {
    const reason = available <= 0 ? "insufficient_balance" : "zero_cap";
    return { ...base, eligible: false, reason, maxRedeemableCoins: 0 };
  }
  if (maxRedeemable < minRedeem) {
    return { ...base, eligible: false, reason: "below_min_redeem", maxRedeemableCoins: maxRedeemable };
  }

  if (requestedCoins == null || requestedCoins === "") {
    return {
      ...base,
      eligible: true,
      reason: "preview_max",
      maxRedeemableCoins: maxRedeemable,
      redeemCoins: maxRedeemable,
      discountPaise: maxRedeemable,
      discountRupees: maxRedeemable / COINS_PER_RUPEE,
      payableAfterDiscountPaise,
    };
  }

  const requested = toNonNegInt(requestedCoins);
  if (requested <= 0) {
    return { ...base, eligible: false, reason: "invalid_requested", maxRedeemableCoins: maxRedeemable };
  }
  if (requested < minRedeem) {
    return { ...base, eligible: false, reason: "below_min_redeem", maxRedeemableCoins: maxRedeemable };
  }
  if (requested > maxRedeemable) {
    // Strict for the reserve path: never silently clamp a booking-time
    // request — the client must re-preview (prevents amount manipulation).
    const reason = requested > available ? "insufficient_balance" : "exceeds_cap";
    return { ...base, eligible: false, reason, maxRedeemableCoins: maxRedeemable };
  }

  return {
    ...base,
    eligible: true,
    reason: "ok",
    maxRedeemableCoins: maxRedeemable,
    redeemCoins: requested,
    discountPaise: requested,
    discountRupees: requested / COINS_PER_RUPEE,
    payableAfterDiscountPaise: gross == null ? null : gross - requested,
  };
};
