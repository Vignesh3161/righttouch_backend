import mongoose from "mongoose";

import Refund from "../Schemas/Refund.js";
import Payment from "../Schemas/Payment.js";
import CustomerRefundPayout from "../Schemas/CustomerRefundPayout.js";
import RefundOutbox from "../Schemas/RefundOutbox.js";
import { getRefundPolicy } from "../Utils/refundPolicy.js";
import {
  previewRefund,
  createRefund,
  approveRefund,
  retryRefund,
} from "../Utils/refundEngine.js";
import { writeAuditLog } from "../Utils/audit.js";

const ok = (res, status, message, result = {}) => res.status(status).json({ success: true, message, result });
const fail = (res, status, message, result = {}) => res.status(status).json({ success: false, message, result });

const requireAdmin = (req, res) => {
  if (!["Admin", "Owner"].includes(req.user?.role)) {
    fail(res, 403, "Admin/Owner access only");
    return false;
  }
  return true;
};

export const adminPreviewRefund = async (req, res) => {
  try {
    const preview = await previewRefund(req.body);
    return ok(res, 200, "Refund preview", { preview });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const adminCreateRefund = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const {
      paymentId,
      requestedPaise,
      reason,
      faultParty,
      materialCostPaise = 0,
      sharePct = 100,
      speed = "normal",
      reportId = null,
      confirmNetRefundPaise,
      approvedBy = null,
    } = req.body;

    if (!paymentId || !reason) return fail(res, 400, "paymentId and reason are required");
    if (reportId) {
      const r = await (await import("../Schemas/Report.js")).default.findById(reportId).lean();
      if (!r) return fail(res, 404, "Report not found");
      if (r.status !== "open" && r.status !== "under_review") {
        return fail(res, 409, "Report already resolved");
      }
    }

    const preview = await previewRefund({
      paymentId,
      requestedPaise,
      reason,
      faultParty,
      materialCostPaise,
      sharePct,
      speed,
    });
    const serverNet = preview.netRefundPaise;
    if (confirmNetRefundPaise != null && Math.abs(serverNet - Number(confirmNetRefundPaise)) > 0) {
      return fail(res, 409, "AMOUNT_CHANGED", { serverNetRefundPaise: serverNet });
    }

    // H9: request dedupe — clients SHOULD send Idempotency-Key; duplicate
    // deliveries with the same key return the original refund.
    const requestIdem = req.get("Idempotency-Key") || req.body.idempotencyKey || null;

    const policy = await getRefundPolicy();
    if (serverNet > policy.REFUND_DUAL_APPROVAL_ABOVE_PAISE && !approvedBy) {
      const awaiting = await createRefund({
        paymentId,
        requestedPaise,
        reason,
        faultParty,
        materialCostPaise,
        sharePct,
        speed,
        reportId,
        initiatedBy: req.user.userId,
        idempotencyKey: requestIdem,
      }).catch((e) => {
        if (e.code === "DUAL_APPROVAL_REQUIRED") return null;
        throw e;
      });
      if (!awaiting) return fail(res, 428, "DUAL_APPROVAL_REQUIRED", { policyAbovePaise: policy.REFUND_DUAL_APPROVAL_ABOVE_PAISE });
      return ok(res, 428, "Refund created, awaiting second-admin approval", { refund: awaiting, serverNetRefundPaise: serverNet });
    }

    const refund = await createRefund({
      paymentId,
      requestedPaise,
      reason,
      faultParty,
      materialCostPaise,
      sharePct,
      speed,
      reportId,
      initiatedBy: req.user.userId,
      approvedBy,
      idempotencyKey: requestIdem,
    });
    return ok(res, 201, "Refund authorised", { refund, serverNetRefundPaise: serverNet });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const adminApproveRefund = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const refund = await approveRefund(req.params.id, req.body.approvedBy || req.user.userId);
    return ok(res, 200, "Refund approved and queued for execution", { refund });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const adminRetryRefund = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const refund = await retryRefund(req.params.id, req.user.userId);
    return ok(res, 200, "Refund re-queued", { refund });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const adminListRefunds = async (req, res) => {
  try {
    const { status } = req.query;
    const q = status ? { status } : {};
    const refunds = await Refund.find(q).sort({ createdAt: -1 }).lean();
    return ok(res, 200, "Refunds", { refunds });
  } catch (e) {
    return fail(res, 500, e.message);
  }
};

export const adminCreateCustomerPayoutRefund = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { refundId, destination } = req.body;
    if (!refundId || !destination) return fail(res, 400, "refundId and destination are required");

    const refund = await Refund.findById(refundId);
    if (!refund) return fail(res, 404, "Refund not found");
    if (refund.rail === "razorpayx_payout") {
      return fail(res, 409, "Customer payout refund already created");
    }
    // H9 Option A (single rail): the razorpay_reverse outbox must be
    // provably unsubmitted before parking it. If the reverse may already
    // have reached the provider, STOP — reconcile first, never double-pay.
    // Reservation + clawback are KEPT (customer is still owed the money).
    if (refund.providerRefundId) {
      await writeAuditLog({
        action: "CUSTOMER_REFUND_PAYOUT_BLOCKED",
        targetType: "Refund",
        targetId: refund._id,
        actor: req.user.userId,
        actorRole: req.user.role,
        after: { reason: "reverse already submitted to provider", providerRefundId: refund.providerRefundId },
      });
      return fail(res, 409, "RAIL_AUTHORITY_AMBIGUOUS", {
        code: "RAIL_AUTHORITY_AMBIGUOUS",
        detail: "Reverse refund already submitted to provider — reconcile provider status before creating a payout rail refund",
        providerRefundId: refund.providerRefundId,
      });
    }
    const reverseOutbox = await RefundOutbox.findOne({ refundId: refund._id }).lean();
    if (reverseOutbox && ["processing", "done"].includes(reverseOutbox.status)) {
      await writeAuditLog({
        action: "CUSTOMER_REFUND_PAYOUT_BLOCKED",
        targetType: "Refund",
        targetId: refund._id,
        actor: req.user.userId,
        actorRole: req.user.role,
        after: { reason: "reverse outbox already claimed/completed", outboxStatus: reverseOutbox.status },
      });
      return fail(res, 409, "RAIL_AUTHORITY_AMBIGUOUS", {
        code: "RAIL_AUTHORITY_AMBIGUOUS",
        detail: `Reverse outbox is '${reverseOutbox.status}' — reconcile provider status before creating a payout rail refund`,
        outboxStatus: reverseOutbox.status,
      });
    }

    const policy = await getRefundPolicy();
    if (refund.netRefundPaise > policy.MAX_CUSTOMER_PAYOUT_REFUND_PAISE) {
      return fail(res, 422, "Amount exceeds manual finance threshold");
    }

    const customer = await (await import("../Schemas/User.js")).default.findById(refund.customerId).lean();
    const destName = destination.accountName || "";
    const nameMatch = !!customer && !!destName && destName.toLowerCase().includes((customer.fname || "").toLowerCase());

    const payout = await CustomerRefundPayout.create({
      refundId,
      customerId: refund.customerId,
      amountPaise: refund.netRefundPaise,
      destination,
      nameMatch,
      status: "pending_approval",
      idempotencyKey: `crp:${refundId}`,
    });

    await Refund.updateOne({ _id: refund._id }, { $set: { rail: "razorpayx_payout", status: "manual_review" } });
    // H9 Option A: park the unclaimed reverse outbox (new → failed with
    // reason) so the worker can never charge the provider on the old rail.
    // Done AFTER the rail flip decision, only for provably-unsubmitted rows.
    if (reverseOutbox && reverseOutbox.status === "new") {
      await RefundOutbox.updateOne(
        { _id: reverseOutbox._id, status: "new" },
        { $set: { status: "failed", lastError: "parked: superseded by razorpayx_payout rail" } }
      );
    }

    await writeAuditLog({
      action: "CUSTOMER_REFUND_PAYOUT_CREATED",
      targetType: "CustomerRefundPayout",
      targetId: payout._id,
      actor: req.user.userId,
      actorRole: req.user.role,
      after: { refundId, amountPaise: payout.amountPaise, nameMatch },
    });

    return ok(res, 201, "Customer refund payout pending approval", { payout });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};
