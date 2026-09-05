import mongoose from "mongoose";
import crypto from "crypto";

import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ServiceCommissionRule from "../Schemas/ServiceCommissionRule.js";
import Payment from "../Schemas/Payment.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import AuditLog from "../Schemas/AuditLog.js";
import { writeAuditLog } from "../Utils/audit.js";
import { toPaise, rupeesToPaise, paiseToRupees, percentageOf } from "../Utils/money.js";
import { CALCULATION_VERSION } from "../Utils/money.js";

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const getConfig = () => {
  const ceiling = toMoney(process.env.COMMISSION_MAX_PERCENTAGE);
  return {
    ceiling: ceiling != null && ceiling > 0 && ceiling <= 100 ? ceiling : 60,
  };
};

const ensureAdmin = (req) => {
  const role = req.user?.role;
  if (role !== "Admin" && role !== "Owner") {
    const err = new Error("Admin or Owner access only");
    err.statusCode = 403;
    throw err;
  }
};

const ok = (res, status, message, result = {}) =>
  res.status(status).json({ success: true, message, result });

const fail = (res, status, message, result = {}) =>
  res.status(status).json({ success: false, message, result });

/* =====================================================
   SET SERVICE COMMISSION  (Admin gives the %)
   Two effects:
     1. Updates the LIVE service field immediately — booking-time
        estimates and the authoritative order split both use it.
     2. Writes a versioned ServiceCommissionRule (effectiveFrom)
        for history/audit; future rules never rewrite past bookings.
===================================================== */

export const setServiceCommission = async (req, res) => {
  try {
    ensureAdmin(req);

    const { serviceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return fail(res, 400, "Valid serviceId required");
    }

    const service = await Service.findById(serviceId);
    if (!service) return fail(res, 404, "Service not found");

    const { commissionPercentage, effectiveFrom, reason } = req.body;
    const { ceiling } = getConfig();

    const pct = toMoney(commissionPercentage);
    if (pct == null || pct < 0 || pct > ceiling) {
      return fail(res, 400, `commissionPercentage must be between 0 and ${ceiling}`);
    }

    let effectiveDate;
    if (effectiveFrom) {
      effectiveDate = new Date(effectiveFrom);
      if (Number.isNaN(effectiveDate.getTime())) {
        return fail(res, 400, "Invalid effectiveFrom date");
      }
    } else {
      effectiveDate = new Date();
    }

    const before = { commissionPercentage: service.commissionPercentage };

    // 1. Live field — applies immediately to new bookings and order splits
    service.commissionPercentage = round2(pct);
    await service.save();

    // 2. Versioned rule — historical record + future effectiveFrom support
    const rule = await ServiceCommissionRule.create({
      serviceId,
      commissionPercentage: round2(pct),
      effectiveFrom: effectiveDate,
      setBy: req.user.userId,
      reason: reason || null,
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "COMMISSION_RULE_CREATED",
      targetType: "Service",
      targetId: serviceId,
      before,
      after: {
        commissionPercentage: round2(pct),
        effectiveFrom: effectiveDate,
        ruleId: rule._id,
      },
      reason: reason || null,
    });

    return ok(res, 200, "Service commission updated", {
      serviceId,
      serviceName: service.serviceName,
      commissionPercentage: round2(pct),
      effectiveFrom: effectiveDate,
      ruleId: rule._id,
      applied: true,
    });
  } catch (error) {
    return fail(res, error.statusCode || 500, error.message);
  }
};

/* =====================================================
   GET SERVICE COMMISSION CONFIG  (Admin view)
   Shows live field, active versioned rule, and what is
   actually effective right now.
===================================================== */

export const getServiceCommission = async (req, res) => {
  try {
    ensureAdmin(req);

    const { serviceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return fail(res, 400, "Valid serviceId required");
    }

    const service = await Service.findById(serviceId)
      .select("serviceName serviceCost discountedPrice commissionPercentage commissionAmount technicianAmount isActive")
      .lean();
    if (!service) return fail(res, 404, "Service not found");

    const rule = await ServiceCommissionRule.findOne({
      serviceId,
      isActive: true,
      effectiveFrom: { $lte: new Date() },
    })
      .sort({ effectiveFrom: -1 })
      .lean();

    const { ceiling } = getConfig();
    const fallback = toMoney(process.env.COMMISSION_DEFAULT_PERCENTAGE) ?? 0;

    const effectivePercentage =
      rule?.commissionPercentage ??
      service.commissionPercentage ??
      fallback;

    return ok(res, 200, "Service commission fetched", {
      serviceId,
      serviceName: service.serviceName,
      livePercentage: service.commissionPercentage,
      activeRule: rule
        ? {
            commissionPercentage: rule.commissionPercentage,
            effectiveFrom: rule.effectiveFrom,
            ruleId: rule._id,
            setBy: rule.setBy,
          }
        : null,
      effectivePercentage,
      platformFallbackPercentage: fallback,
      maxAllowedPercentage: ceiling,
    });
  } catch (error) {
    return fail(res, error.statusCode || 500, error.message);
  }
};

/* =====================================================
   LIST ALL SERVICES WITH COMMISSION  (Admin UI list)
   Paginated + searchable. Shows live % and the effective
   % (versioned rule wins over live field).
===================================================== */

export const getAllServiceCommissions = async (req, res) => {
  try {
    ensureAdmin(req);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const skip = (page - 1) * limit;

    const match = {};
    if (req.query.search && String(req.query.search).trim()) {
      match.serviceName = { $regex: String(req.query.search).trim(), $options: "i" };
    }

    const [services, total] = await Promise.all([
      Service.find(match)
        .select("serviceName categoryId serviceCost discountedPrice commissionPercentage isActive")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Service.countDocuments(match),
    ]);

    // Batch-load active versioned rules for this page (1 extra query)
    const ids = services.map((s) => s._id);
    const rules = ids.length
      ? await ServiceCommissionRule.find({
          serviceId: { $in: ids },
          isActive: true,
          effectiveFrom: { $lte: new Date() },
        })
          .sort({ effectiveFrom: -1 })
          .lean()
      : [];

    const ruleByService = new Map();
    for (const r of rules) {
      if (!ruleByService.has(String(r.serviceId))) {
        ruleByService.set(String(r.serviceId), r);
      }
    }

    const { ceiling } = getConfig();
    const fallback = toMoney(process.env.COMMISSION_DEFAULT_PERCENTAGE) ?? 0;

    const items = services.map((s) => {
      const activeRule = ruleByService.get(String(s._id)) || null;
      return {
        serviceId: s._id,
        serviceName: s.serviceName,
        categoryId: s.categoryId,
        serviceCost: s.serviceCost,
        discountedPrice: s.discountedPrice,
        livePercentage: s.commissionPercentage ?? 0,
        effectivePercentage: activeRule?.commissionPercentage ?? s.commissionPercentage ?? fallback,
        ruleEffectiveFrom: activeRule?.effectiveFrom || null,
        ruleId: activeRule?._id || null,
        isActive: s.isActive,
      };
    });

    return ok(res, 200, "Service commissions fetched", {
      services: items,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      platformFallbackPercentage: fallback,
      maxAllowedPercentage: ceiling,
    });
  } catch (error) {
    return fail(res, error.statusCode || 500, error.message);
  }
};

/* =====================================================
   BOOKING-LEVEL COMMISSION OVERRIDE  (audited)
   Allowed only while the booking is unpaid and unsettled.
   Recomputes the pending Payment split if one exists.
===================================================== */

export const overrideBookingCommission = async (req, res) => {
  try {
    ensureAdmin(req);

    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "Valid bookingId required");
    }

    // Accept EXACTLY ONE of commissionAmountPaise | commissionPercentage, plus reason.
    const { commissionAmountPaise, commissionAmount, commissionPercentage, reason } = req.body;
    const requestId = req.headers["x-request-id"] || crypto.randomUUID();

    if (!reason || !String(reason).trim()) {
      return fail(res, 400, "A reason is required for commission overrides");
    }

    const amtPaise = commissionAmountPaise != null ? toPaise(commissionAmountPaise) : null;
    const amtRupees = amtPaise != null ? null : toMoney(commissionAmount);
    const pct = commissionPercentage != null ? toMoney(commissionPercentage) : null;

    const hasAmount = amtPaise != null || amtRupees != null;
    if (hasAmount && pct != null) {
      return fail(res, 400, "Provide EITHER commissionAmountPaise OR commissionPercentage, not both");
    }
    if (!hasAmount && pct == null) {
      return fail(res, 400, "Provide commissionAmountPaise or commissionPercentage");
    }

    const { ceiling } = getConfig();
    const booking = await ServiceBooking.findById(bookingId);
    if (!booking) return fail(res, 404, "Booking not found");

    if (booking.paymentStatus === "paid") {
      return fail(res, 409, "Cannot override commission after payment has succeeded");
    }
    if (booking.settlementStatus === "settled") {
      return fail(res, 409, "Cannot override commission after settlement");
    }

    // Guards: no withdrawal created, no payout processing for this booking's technician
    const openWithdrawal = await WithdrawalRequest.findOne({
      technicianId: booking.technicianId,
      status: { $in: ["pending", "requested", "approved", "processing"] },
    }).lean();
    if (openWithdrawal) {
      return fail(res, 409, "Cannot override while a withdrawal request is pending/processing");
    }

    const snapshot = booking.financialSnapshot || {};
    const basePaise = toPaise(snapshot.baseAmountPaise ?? rupeesToPaise(booking.baseAmount));
    const totalPaise = toPaise(snapshot.totalAmountPaise ?? rupeesToPaise(booking.totalAmount ?? booking.baseAmount));
    const tipPaise = toPaise(snapshot.tipAmountPaise ?? rupeesToPaise(booking.tipAmount));

    let newCommissionAmountPaise;
    let newCommissionPercentage;

    if (amtPaise != null || amtRupees != null) {
      const value = amtPaise ?? toPaise(rupeesToPaise(amtRupees));
      if (value < 0) return fail(res, 400, "commissionAmountPaise must be >= 0");
      if (value > basePaise) {
        return fail(res, 400, "commissionAmountPaise cannot exceed baseAmountPaise");
      }
      newCommissionAmountPaise = value;
      newCommissionPercentage =
        basePaise > 0 ? (value / basePaise) * 100 : 0;
    } else {
      if (pct < 0 || pct > ceiling) {
        return fail(res, 400, `commissionPercentage must be between 0 and ${ceiling}`);
      }
      newCommissionPercentage = Math.round(pct * 100) / 100;
      newCommissionAmountPaise = Math.min(percentageOf(basePaise, newCommissionPercentage), basePaise);
    }

    const newTechnicianAmountPaise = totalPaise - newCommissionAmountPaise;
    if (newTechnicianAmountPaise < 0) {
      return fail(res, 400, "technicianAmountPaise cannot be negative");
    }
    // Invariant: commission + technician === total
    if (newCommissionAmountPaise + newTechnicianAmountPaise !== totalPaise) {
      return fail(res, 500, "Split invariant broken");
    }

    const before = {
      financialSnapshot: booking.financialSnapshot || null,
      commissionPercentage: booking.commissionPercentage,
      commissionAmountPaise: toPaise(snapshot.commissionAmountPaise),
      technicianAmountPaise: toPaise(snapshot.technicianAmountPaise),
      commissionOverridden: booking.commissionOverridden,
    };

    const after = {
      financialSnapshot: {
        ...snapshot,
        commissionPercentage: newCommissionPercentage,
        commissionAmountPaise: newCommissionAmountPaise,
        technicianAmountPaise: newTechnicianAmountPaise,
        commissionRuleSource: "booking_override_amount",
        commissionRuleId: null,
        commissionOverridden: true,
        calculationVersion: CALCULATION_VERSION,
        financialSnapshotAt: new Date(),
      },
      commissionPercentage: newCommissionPercentage,
      commissionAmountPaise: newCommissionAmountPaise,
      technicianAmountPaise: newTechnicianAmountPaise,
      commissionOverridden: true,
    };

    // 🔒 Booking + pending Payment split must move atomically
    const session = await mongoose.startSession();
    let recomputedPayment = null;
    try {
      await session.withTransaction(async () => {
        const freshBooking = await ServiceBooking.findById(bookingId).session(session);
        if (!freshBooking) throw Object.assign(new Error("Booking not found"), { statusCode: 404 });
        if (freshBooking.paymentStatus === "paid") {
          throw Object.assign(new Error("Cannot override commission after payment"), { statusCode: 409 });
        }

        freshBooking.financialSnapshot = after.financialSnapshot;
        freshBooking.commissionPercentage = newCommissionPercentage;
        freshBooking.commissionAmount = paiseToRupees(newCommissionAmountPaise);
        freshBooking.commissionAmountPaise = newCommissionAmountPaise;
        freshBooking.technicianAmount = paiseToRupees(newTechnicianAmountPaise);
        freshBooking.technicianAmountPaise = newTechnicianAmountPaise;
        freshBooking.commissionOverridden = true;
        await freshBooking.save({ session });

        // Keep any unpaid Payment consistent with the override (same txn).
        const payment = await Payment.findOne({ bookingId, status: { $ne: "success" } }).session(session);
        if (payment) {
          payment.commissionAmountPaise = newCommissionAmountPaise;
          payment.technicianAmountPaise = newTechnicianAmountPaise;
          payment.commissionPercentage = newCommissionPercentage;
          payment.commissionRuleSource = "booking_override_amount";
          payment.calculationVersion = CALCULATION_VERSION;
          payment.providerOrderId = null; // force fresh order on next checkout
          payment.providerPaymentId = null;
          payment.status = "pending";
          await payment.save({ session });
          recomputedPayment = payment;
        }
      });
    } finally {
      session.endSession();
    }

    // 📜 IMMUTABLE AUDIT — old snapshot, new snapshot, reason, timestamp, request ID
    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "COMMISSION_BOOKING_OVERRIDE",
      targetType: "ServiceBooking",
      targetId: bookingId,
      before,
      after,
      reason,
      metadata: { requestId, paymentUpdated: !!recomputedPayment },
    });

    return ok(res, 200, "Booking commission overridden", {
      bookingId,
      requestId,
      commissionAmountPaise: newCommissionAmountPaise,
      commissionPercentage: newCommissionPercentage,
      technicianAmountPaise: newTechnicianAmountPaise,
      totalAmountPaise: totalPaise,
    });
  } catch (error) {
    return fail(res, error.statusCode || 500, error.message);
  }
};

/* =====================================================
   AUDIT LOG QUERY  (Admin/Owner)
===================================================== */

export const getAuditLogs = async (req, res) => {
  try {
    ensureAdmin(req);

    const query = {};
    if (req.query.action) query.action = req.query.action;
    if (req.query.targetType) query.targetType = req.query.targetType;
    if (req.query.targetId && mongoose.Types.ObjectId.isValid(req.query.targetId)) {
      query.targetId = req.query.targetId;
    }
    if (req.query.from || req.query.to) {
      query.createdAt = {};
      if (req.query.from) query.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) query.createdAt.$lte = new Date(req.query.to);
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    return ok(res, 200, "Audit logs fetched", {
      logs,
      total,
      page: Math.floor(skip / limit) + 1,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return fail(res, error.statusCode || 500, error.message);
  }
};
