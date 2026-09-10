import mongoose from "mongoose";
import { randomUUID } from "node:crypto";

import Payment from "../Schemas/Payment.js";
import Refund from "../Schemas/Refund.js";
import Report from "../Schemas/Report.js";
import CreditNote from "../Schemas/CreditNote.js";
import RefundOutbox from "../Schemas/RefundOutbox.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

import { postLedgerEntry } from "./ledger.js";
import { writeAuditLog } from "./audit.js";
import {
  getRefundPolicy,
  computeMdrLossPaise,
  isGstRecoverable,
  computeGstDeadline,
  defaultFaultParty,
} from "./refundPolicy.js";
import { applyClawback, reverseClawback } from "./refundClawback.js";
import { releaseOnResolution } from "./complaintFreeze.js";
import { createRazorpayRefund, fetchRazorpayRefund } from "./razorpay.js";
import { getIo } from "./ioAccess.js";
import { sendPushNotification } from "./sendNotification.js";
import { SOCKET_ROOMS, SOCKET_EVENTS } from "./socketConstants.js";
import { toPaise, paiseToRupees } from "./money.js";

const RefundError = (code, statusCode, message) => {
  const e = new Error(message || code);
  e.code = code;
  e.statusCode = statusCode;
  return e;
};

const runTxn = async (fn) => {
  let session;
  try {
    session = await mongoose.startSession();
    return await session.withTransaction(() => fn(session));
  } catch (e) {
    if (/replica set|Transaction|mongos/.test(String(e?.message || ""))) {
      return await fn(null);
    }
    throw e;
  } finally {
    if (session) session.endSession();
  }
};

const getBookingParties = async (bookingId, itemType) => {
  if (itemType === "product") {
    try {
      const pb = await (await import("../Schemas/ProductBooking.js")).default
        .findById(bookingId)
        .lean();
      if (pb) return { technicianId: null, customerId: pb.userId || pb.customerId || null };
    } catch {}
  }
  const sb = await ServiceBooking.findById(bookingId).lean();
  if (sb) return { technicianId: sb.technicianId || null, customerId: sb.customerId || sb.userId || null };
  return { technicianId: null, customerId: null };
};

const emit = (roomId, event, payload) => {
  try {
    const io = getIo();
    if (io && roomId) io.to(roomId).emit(event, payload);
  } catch {}
};

const push = async (recipientId, title, body, data, opts) => {
  try {
    await sendPushNotification(recipientId, { title, body, data }, opts);
  } catch {}
};

export const computeRefundAllocation = async ({
  paymentId,
  requestedPaise = 0,
  reason,
  faultParty,
  materialCostPaise = 0,
  sharePct = 100,
  speed = "normal",
  policy,
}) => {
  const p = await Payment.findById(paymentId).lean();
  if (!p) throw RefundError("PAYMENT_NOT_FOUND", 404);
  const policyObj = policy || (await getRefundPolicy());
  const captured = toPaise(p.capturedAmountPaise ?? p.totalAmountPaise);
  const already = toPaise(p.amountRefundedPaise || 0);
  const refundable = captured - already;
  if (refundable <= 0) throw RefundError("ALREADY_FULLY_REFUNDED", 409);

  let net = Math.min(toPaise(requestedPaise) || captured, refundable) - toPaise(materialCostPaise || 0);
  net = Math.max(net, 0);

  const total = toPaise(p.totalAmountPaise) || 1;
  const fp = faultParty || defaultFaultParty(reason);
  let clawbackRequired = 0;
  if (fp === "technician" || fp === "shared") {
    const techShare = toPaise(p.technicianAmountPaise) / total;
    clawbackRequired = Math.round(net * techShare * (sharePct / 100));
  }
  const commissionReversed = Math.round(net * (toPaise(p.commissionAmountPaise) / total));
  const mdrLoss = computeMdrLossPaise(net, policyObj);
  const processingFee = speed === "optimum" ? toPaise(policyObj.INSTANT_REFUND_FEE_PAISE || 0) : 0;
  const gstRecoverable = isGstRecoverable(p.createdAt);

  const breakdown = {
    basePaise: Math.round(net * (toPaise(p.baseAmountPaise) / total)),
    gstPaise: Math.round(net * (toPaise(p.gstAmountPaise) / total)),
    tipPaise: Math.round(net * (toPaise(p.tipAmountPaise) / total)),
    productPaise: 0,
  };

  return {
    captured,
    refundable,
    netRefundPaise: net,
    clawbackRequiredPaise: clawbackRequired,
    commissionReversedPaise: commissionReversed,
    mdrLossPaise: mdrLoss,
    processingFeePaise: processingFee,
    gstRecoverable,
    breakdown,
    faultParty: fp,
  };
};

export const previewRefund = async ({ paymentId, requestedPaise, reason, faultParty, materialCostPaise = 0, sharePct = 100, speed = "normal" }) => {
  const policy = await getRefundPolicy();
  const alloc = await computeRefundAllocation({
    paymentId,
    requestedPaise,
    reason,
    faultParty,
    materialCostPaise,
    sharePct,
    speed,
    policy,
  });

  let reserveAvail = 0;
  let availAvail = 0;
  const parties = await getBookingParties(
    (await Payment.findById(paymentId).lean())?.bookingId,
    (await Payment.findById(paymentId).lean())?.itemType
  );
  if (parties.technicianId) {
    const tech = await TechnicianProfile.findById(parties.technicianId)
      .select("reserveBalancePaise availableBalancePaise outstandingDuesPaise")
      .lean();
    reserveAvail = tech?.reserveBalancePaise || 0;
    availAvail = tech?.availableBalancePaise || 0;
  }
  const fromReserve = Math.min(reserveAvail, alloc.clawbackRequiredPaise);
  const fromAvail = Math.min(availAvail, alloc.clawbackRequiredPaise - fromReserve);
  const toDues = Math.max(alloc.clawbackRequiredPaise - fromReserve - fromAvail, 0);

  return {
    ...alloc,
    clawbackPlan: { fromReservePaise: fromReserve, fromAvailablePaise: fromAvail, toDuesPaise: toDues },
    gstDeadline: computeGstDeadline((await Payment.findById(paymentId).lean())?.createdAt),
  };
};

export const createRefund = async ({
  paymentId,
  requestedPaise,
  reason,
  faultParty,
  materialCostPaise = 0,
  sharePct = 100,
  speed = "normal",
  reportId = null,
  initiatedBy = null,
  approvedBy = null,
  note = null,
}) => {
  const policy = await getRefundPolicy();
  const alloc = await computeRefundAllocation({
    paymentId,
    requestedPaise,
    reason,
    faultParty,
    materialCostPaise,
    sharePct,
    speed,
    policy,
  });

  const refund = await runTxn(async (session) => {
    const opts = session ? { session } : {};
    const payment = await Payment.findById(paymentId).session(session);
    if (!payment) throw RefundError("PAYMENT_NOT_FOUND", 404);
    if (payment.status !== "success") throw RefundError("PAYMENT_NOT_CAPTURED", 422);

    const captured = toPaise(payment.capturedAmountPaise ?? payment.totalAmountPaise);
    const already = toPaise(payment.amountRefundedPaise || 0);
    const refundable = captured - already;
    if (alloc.netRefundPaise > refundable) throw RefundError("REFUND_EXCEEDS_CAPTURED", 422);
    if (alloc.netRefundPaise <= 0) throw RefundError("REFUND_EXCEEDS_CAPTURED", 422);
    const needsApproval = alloc.netRefundPaise > policy.REFUND_DUAL_APPROVAL_ABOVE_PAISE && !approvedBy;
    if (needsApproval) {
      throw RefundError("DUAL_APPROVAL_REQUIRED", 428);
    }

    // Atomically reserve the refund amount against the payment so two
    // concurrent createRefund calls cannot both pass the check above and
    // over-refund the customer. The $expr guard ensures the new total never
    // exceeds the captured amount.
    const reserved = await Payment.findOneAndUpdate(
      {
        _id: paymentId,
        status: "success",
        $expr: { $lte: [ { $add: ["$amountRefundedPaise", alloc.netRefundPaise] }, captured ] },
      },
      { $inc: { amountRefundedPaise: alloc.netRefundPaise } },
      { new: true, ...opts }
    );
    if (!reserved) throw RefundError("REFUND_EXCEEDS_CAPTURED", 422);

    const parties = await getBookingParties(payment.bookingId, payment.itemType);
    const idem = `refund:${paymentId}:${randomUUID()}`;

    const [ref] = await Refund.create(
      [
        {
          paymentId,
          bookingId: payment.bookingId,
          bookingType: payment.itemType,
          customerId: parties.customerId,
          technicianId: parties.technicianId,
          refundClass: faultParty && faultParty !== "platform" ? "adjudication" : "restitution",
          reason,
          faultParty: alloc.faultParty,
          sharePct,
          reportId,
          initiatedBy,
          approvedBy,
          grossPaise: alloc.netRefundPaise,
          breakdown: alloc.breakdown,
          materialCostPaise: toPaise(materialCostPaise || 0),
          netRefundPaise: alloc.netRefundPaise,
          clawbackRequiredPaise: alloc.clawbackRequiredPaise,
          commissionReversedPaise: alloc.commissionReversedPaise,
          mdrLossPaise: alloc.mdrLossPaise,
          processingFeePaise: alloc.processingFeePaise,
          gstRecoverable: alloc.gstRecoverable,
          rail: "razorpay_reverse",
          speed,
          idempotencyKey: idem,
          status: "pending_execution",
          awaitingApproval: needsApproval,
          createdAt: new Date(),
        },
      ],
      opts
    );

    if (alloc.clawbackRequiredPaise > 0 && parties.technicianId) {
      const r = await applyClawback({
        technicianId: parties.technicianId,
        refundId: ref._id,
        amountPaise: alloc.clawbackRequiredPaise,
        session,
      });
      ref.clawbackAppliedPaise = r.appliedReserve + r.appliedAvailable;
      ref.clawbackFromReservePaise = r.appliedReserve;
      ref.clawbackToDuesPaise = r.toDues;
      await ref.save(opts);
    }

    await postLedgerEntry({
      type: "customer_refund",
      direction: "debit",
      amountPaise: alloc.netRefundPaise,
      idempotencyKey: `refund:${ref._id}:ledger:customer`,
      refs: { bookingId: payment.bookingId, paymentId, technicianId: parties.technicianId },
      description: `Customer refund (${reason})`,
      session,
    });
    if (alloc.commissionReversedPaise > 0) {
      await postLedgerEntry({
        type: "commission_reversal",
        direction: "debit",
        amountPaise: alloc.commissionReversedPaise,
        idempotencyKey: `refund:${ref._id}:ledger:commission`,
        refs: { bookingId: payment.bookingId, paymentId },
        description: "Platform commission reversed on refund",
        session,
      });
    }
    await postLedgerEntry({
      type: "mdr_loss",
      direction: "debit",
      amountPaise: alloc.mdrLossPaise,
      idempotencyKey: `refund:${ref._id}:ledger:mdr`,
      refs: { bookingId: payment.bookingId, paymentId },
      description: "Non-recoverable gateway MDR on refunded payment",
      session,
    });
    if (alloc.processingFeePaise > 0) {
      await postLedgerEntry({
        type: "refund_processing_fee",
        direction: "debit",
        amountPaise: alloc.processingFeePaise,
        idempotencyKey: `refund:${ref._id}:ledger:processing`,
        refs: { bookingId: payment.bookingId, paymentId },
        description: "Instant refund processing fee",
        session,
      });
    }

    const deadline = computeGstDeadline(payment.createdAt);
    const [cn] = await CreditNote.create(
      [
        {
          refundId: ref._id,
          creditNoteNumber: `CN-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
          taxableValuePaise: alloc.breakdown.basePaise,
          cgstPaise: Math.round(alloc.breakdown.gstPaise / 2),
          sgstPaise: Math.round(alloc.breakdown.gstPaise / 2),
          totalPaise: alloc.netRefundPaise,
          issuedAt: new Date(),
          gstReturnPeriod: null,
          declared: false,
          deadline,
        },
      ],
      opts
    );
    ref.creditNoteId = cn._id;
    await ref.save(opts);

    if (!needsApproval) {
      await RefundOutbox.create([{ refundId: ref._id, status: "new" }], opts);
    }

    if (reportId && !needsApproval) {
      await Report.updateOne(
        { _id: reportId },
        { $set: { status: "resolved_refunded", reviewedAt: new Date(), refundId: ref._id } },
        opts
      );
    }

    if (!needsApproval) {
      // amountRefundedPaise was already atomically reserved above; just
      // reflect the fully-refunded status on the in-memory doc.
      if (reserved.amountRefundedPaise >= captured) payment.status = "refunded";
      await payment.save(opts);
    }

    await writeAuditLog({
      action: "REFUND_AUTHORISED",
      targetType: "Refund",
      targetId: ref._id,
      actor: initiatedBy,
      actorRole: approvedBy ? "Admin" : "System",
      after: {
        netRefundPaise: alloc.netRefundPaise,
        clawbackRequiredPaise: alloc.clawbackRequiredPaise,
        faultParty: alloc.faultParty,
        reason,
      },
      reason: note,
      session,
    });

    return ref;
  });

  if (!refund.awaitingApproval) {
    emit(SOCKET_ROOMS.CUSTOMER(refund.customerId), SOCKET_EVENTS.REFUND_INITIATED, {
      refundId: String(refund._id),
      amountPaise: refund.netRefundPaise,
      amount: paiseToRupees(refund.netRefundPaise),
      reason,
    });
    await push(refund.customerId, "Refund initiated", `₹${paiseToRupees(refund.netRefundPaise).toFixed(2)} refund initiated`, {
      type: "REFUND_INITIATED",
      refundId: String(refund._id),
    }, { recipientType: "customer" });
  }

  return refund;
};

export const approveRefund = async (refundId, approvedBy) => {
  const refund = await Refund.findById(refundId);
  if (!refund) throw RefundError("REFUND_NOT_FOUND", 404);
  if (!refund.awaitingApproval) throw RefundError("REFUND_NOT_PENDING_APPROVAL", 409);

  refund.awaitingApproval = false;
  refund.approvedBy = approvedBy || refund.approvedBy;
  await refund.save();

  await RefundOutbox.create([{ refundId: refund._id, status: "new" }]);

  if (refund.reportId) {
    await Report.updateOne(
      { _id: refund.reportId },
      { $set: { status: "resolved_refunded", reviewedAt: new Date(), refundId: refund._id } }
    );
  }
  const payment = await Payment.findById(refund.paymentId);
  if (payment) {
    // The refund amount was already reserved on Payment.amountRefundedPaise at
    // createRefund time, so we only flip the status here (no second increment).
    const captured = toPaise(payment.capturedAmountPaise ?? payment.totalAmountPaise);
    if (toPaise(payment.amountRefundedPaise || 0) >= captured) payment.status = "refunded";
    await payment.save();
  }

  emit(SOCKET_ROOMS.CUSTOMER(refund.customerId), SOCKET_EVENTS.REFUND_INITIATED, {
    refundId: String(refund._id),
    amountPaise: refund.netRefundPaise,
    amount: paiseToRupees(refund.netRefundPaise),
    reason: refund.reason,
  });

  return refund;
};

export const executeRefund = async (refundId) => {
  const refund = await Refund.findById(refundId);
  if (!refund) throw RefundError("REFUND_NOT_FOUND", 404);
  if (!["pending_execution", "retrying"].includes(refund.status)) return refund;

  try {
    const rzp = await createRazorpayRefund({
      paymentId: String(refund.paymentId),
      amountInPaisa: refund.netRefundPaise,
      speed: refund.speed,
      receipt: String(refund._id),
      idempotencyKey: refund.idempotencyKey,
    });

    refund.status = "processed";
    refund.providerRefundId = rzp.id;
    refund.providerStatus = rzp.status;
    refund.executedAt = new Date();
    refund.processedAt = new Date();
    await refund.save();

    await CreditNote.updateOne({ refundId: refund._id }, { $set: { declared: true } });
    await RefundOutbox.updateOne({ refundId: refund._id }, { $set: { status: "done" } });

    emit(SOCKET_ROOMS.CUSTOMER(refund.customerId), SOCKET_EVENTS.REFUND_PROCESSED, {
      refundId: String(refund._id),
      amountPaise: refund.netRefundPaise,
      amount: paiseToRupees(refund.netRefundPaise),
    });
    await push(refund.customerId, "Refund processed", `₹${paiseToRupees(refund.netRefundPaise).toFixed(2)} credited to your original payment method`, {
      type: "REFUND_PROCESSED",
      refundId: String(refund._id),
    }, { recipientType: "customer" });

    return refund;
  } catch (e) {
    const statusCode = e?.statusCode || 500;
    const msg = String(e?.message || "");
    refund.attempts = (refund.attempts || 0) + 1;
    refund.lastError = msg;

    if (statusCode >= 400 && statusCode < 500) {
      refund.status = "failed";
      await refund.save();
      // Revert the reservation made at createRefund (terminal provider failure).
      await Payment.updateOne(
        { _id: refund.paymentId },
        { $inc: { amountRefundedPaise: -refund.netRefundPaise } }
      );
      if (refund.clawbackRequiredPaise > 0 && refund.technicianId) {
        await reverseClawback({ technicianId: refund.technicianId, refundId: refund._id });
      }
      if (refund.reportId) {
        await Report.updateOne({ _id: refund.reportId }, { $set: { status: "open" } });
      }
      await RefundOutbox.updateOne({ refundId: refund._id }, { $set: { status: "failed" } });
      emit(SOCKET_ROOMS.ADMIN_DASHBOARD, SOCKET_EVENTS.REFUND_MANUAL_REVIEW, {
        refundId: String(refund._id),
        error: msg,
      });
    } else if (/source|invalid_refund/.test(msg)) {
      refund.status = "unrefundable_source";
      await refund.save();
      await Payment.updateOne(
        { _id: refund.paymentId },
        { $inc: { amountRefundedPaise: -refund.netRefundPaise } }
      );
      await RefundOutbox.updateOne({ refundId: refund._id }, { $set: { status: "failed" } });
    } else {
      refund.status = "manual_review";
      await refund.save();
    }
    throw e;
  }
};

export const refundWorker = async (limit = 25) => {
  const batch = await RefundOutbox.find({ status: "new" }).limit(limit).lean();
  for (const item of batch) {
    try {
      await executeRefund(item.refundId);
    } catch (e) {
      const refund = await Refund.findById(item.refundId).lean();
      if (refund && refund.attempts >= 3) {
        await RefundOutbox.updateOne({ refundId: item.refundId }, { $set: { status: "failed" } });
        // Terminal failure: release the createRefund reservation so the
        // customer can be refunded again through a fresh request.
        await Payment.updateOne(
          { _id: refund.paymentId },
          { $inc: { amountRefundedPaise: -refund.netRefundPaise } }
        );
      }
    }
  }
  return { processed: batch.length };
};

export const reconcileRefunds = async () => {
  const stale = await Refund.find({
    status: "initiated",
    executedAt: { $lte: new Date(Date.now() - 10 * 60 * 1000) },
  }).lean();
  for (const r of stale) {
    if (!r.providerRefundId) continue;
    try {
      const rzp = await fetchRazorpayRefund(r.providerRefundId);
      if (rzp.status === "processed" || rzp.status === "captured") {
        r.status = "processed";
        r.processedAt = new Date();
        await r.save();
        await CreditNote.updateOne({ refundId: r._id }, { $set: { declared: true } });
      } else if (rzp.status === "failed") {
        r.status = "failed";
        await r.save();
      }
    } catch (e) {
      console.error(`[RefundReconcile] refund ${r._id}: ${e.message}`);
    }
  }
  return { checked: stale.length };
};

export const retryRefund = async (refundId, adminId) => {
  const refund = await Refund.findById(refundId);
  if (!refund) throw RefundError("REFUND_NOT_FOUND", 404);
  if (refund.attempts >= 3) throw RefundError("MAX_ATTEMPTS_EXCEEDED", 409);
  if (!["failed", "manual_review"].includes(refund.status)) {
    throw RefundError("REFUND_IN_FLIGHT", 409);
  }
  refund.status = "retrying";
  await refund.save();
  await RefundOutbox.updateOne(
    { refundId },
    { $set: { status: "new", nextAttemptAt: new Date() } },
    { upsert: true }
  );
  return refund;
};

export const handleRefundWebhook = async (event, payload) => {
  if (event !== "refund.processed" && event !== "refund.failed") return;
  const rzpId = payload?.refund?.entity?.id || payload?.entity?.id;
  if (!rzpId) return;
  const refund = await Refund.findOne({ providerRefundId: rzpId });
  if (!refund) return;
  if (event === "refund.processed" && refund.status !== "processed") {
    refund.status = "processed";
    refund.processedAt = new Date();
    await refund.save();
    await CreditNote.updateOne({ refundId: refund._id }, { $set: { declared: true } });
  } else if (event === "refund.failed" && refund.status !== "failed") {
    refund.status = "failed";
    await refund.save();
    if (refund.clawbackRequiredPaise > 0 && refund.technicianId) {
      await reverseClawback({ technicianId: refund.technicianId, refundId: refund._id });
    }
  }
};

export const classARefundScanner = async () => {
  const policy = await getRefundPolicy();
  const cutoff = new Date(Date.now() - policy.REFUND_STALE_HOURS * 36e5);
  const candidates = await Payment.find({
    status: "success",
    amountRefundedPaise: 0,
    createdAt: { $lte: cutoff },
  }).lean();
  let created = 0;
  for (const p of candidates) {
    const existing = await Refund.findOne({ paymentId: p._id, refundClass: "restitution" }).lean();
    if (existing) continue;
    const sb = await ServiceBooking.findById(p.bookingId).lean();
    const served = sb && (sb.status === "completed" || sb.status === "in_progress");
    if (served) continue;
    try {
      await createRefund({
        paymentId: p._id,
        requestedPaise: p.totalAmountPaise,
        reason: "service_not_rendered",
        faultParty: "platform",
        initiatedBy: null,
      });
      created += 1;
    } catch (e) {
      console.error(`[ClassAScanner] payment ${p._id}: ${e.message}`);
    }
  }
  return { created };
};

export const complaintSlaEscalation = async () => {
  const now = new Date();
  const overdue = await Report.find({ status: "open", slaDeadline: { $lte: now } }).lean();
  for (const r of overdue) {
    emit(SOCKET_ROOMS.ADMIN_DASHBOARD, "complaint:sla_breach", {
      reportId: String(r._id),
      slaDeadline: r.slaDeadline,
    });
  }
  return { escalated: overdue.length };
};
