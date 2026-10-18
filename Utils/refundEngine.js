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

const runTxn = async (fn, meta = {}) => {
  let session;
  try {
    session = await mongoose.startSession();
    return await session.withTransaction(() => fn(session));
  } catch (e) {
    if (/replica set|Transaction|mongos/.test(String(e?.message || ""))) {
      // 3A-3: previously SILENT non-transactional fallback. Standalone/dev
      // continuity is preserved (atomic reserve + idempotent keys still hold
      // per-operation), but the downgrade is now LOUD and actionable via the
      // existing reconciliation-exception contract — consistent with the
      // settlement standalone fallback (warn + verify + reconcile). Production
      // MUST run a replica set; every fallback instance is surfaced.
      console.error(
        `[Refund] NON-TRANSACTIONAL fallback for ${meta.op || "refund-op"} — replica set required for atomicity`
      );
      try {
        const { raiseReconciliationException } = await import("./paymentTransitions.js");
        await raiseReconciliationException({
          code: "REFUND_NON_TRANSACTIONAL_FALLBACK",
          severity: "critical",
          details: { op: meta.op || "refund-op", ...(meta.details || {}) },
        });
      } catch (raiseErr) {
        console.error("[Refund] fallback exception surfacing failed:", raiseErr?.message || raiseErr);
      }
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

/**
 * H9/H10: conditional, idempotent reservation release.
 * Decrements Payment.amountRefundedPaise ONLY when at least `netPaise` is
 * currently reserved ($gte guard), so racing failure paths (executeRefund,
 * worker catch, reconcile, webhook) cannot double-release below zero or
 * hand the same reserved amount to two retries.
 * @returns {boolean} true if the release was applied.
 */
export const releaseRefundReservation = async (paymentId, netPaise) => {
  const net = toPaise(netPaise || 0);
  if (!paymentId || !(net > 0)) return false;
  const res = await Payment.updateOne(
    { _id: paymentId, amountRefundedPaise: { $gte: net } },
    { $inc: { amountRefundedPaise: -net } }
  );
  return (res.modifiedCount || 0) > 0;
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
  idempotencyKey = null,
}) => {
  // H9: request-level dedupe — retried admin calls carrying the same
  // Idempotency-Key return the original refund instead of creating a
  // duplicate logical refund (atomic reserve ceiling is the backstop).
  if (idempotencyKey) {
    const existing = await Refund.findOne({ idempotencyKey }).lean();
    if (existing) return existing;
  }
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
    const idem = idempotencyKey || `refund:${paymentId}:${randomUUID()}`;

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
      // H14: never overwrite a terminal complaint resolution — only an
      // open/under-review report may transition to resolved_refunded here.
      // Terminal updates belong to the canonical complaintService flow.
      await Report.updateOne(
        { _id: reportId, status: { $in: ["open", "under_review"] } },
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
  }, { op: "createRefund", details: { paymentId: String(paymentId) } });

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
    // H14: same terminal-state guard as createRefund.
    await Report.updateOne(
      { _id: refund.reportId, status: { $in: ["open", "under_review"] } },
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

export const executeRefund = async (refundId, deps = {}) => {
  const createProvider = deps.createProvider || createRazorpayRefund;
  // H9: two-level atomic ownership for one execution attempt.
  //  (1) Outbox mutex (SAME row/state machine as the Phase-1 worker claim —
  //      no conflicting mechanism): the caller must hold `processing`. The
  //      worker holds it already (pass ownedClaim:true); direct callers claim
  //      new→processing here, and concurrent claimants lose atomically.
  //  (2) Refund attempt fence: status filter + attempts increment in ONE
  //      findOneAndUpdate, so attempt accounting is exact under concurrency.
  //  Plus the stable provider idempotency key (set once at creation, never
  //  regenerated) for provider-side dedupe of any residual overlap.
  if (!deps.ownedClaim) {
    await RefundOutbox.updateOne(
      { refundId },
      { $setOnInsert: { status: "new", attempts: 0 } },
      { upsert: true }
    );
    const owned = await RefundOutbox.findOneAndUpdate(
      { refundId, status: "new" },
      { $set: { status: "processing" } },
      { new: true }
    ).lean();
    if (!owned) {
      const current = await Refund.findById(refundId).lean();
      if (!current) throw RefundError("REFUND_NOT_FOUND", 404);
      return current;
    }
  }
  const refund = await Refund.findOneAndUpdate(
    { _id: refundId, status: { $in: ["pending_execution", "retrying"] } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!refund) {
    const current = await Refund.findById(refundId).lean();
    if (!current) throw RefundError("REFUND_NOT_FOUND", 404);
    return current;
  }

  try {
    const rzp = await createProvider({
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

    // 🪙 Reverse rewards earned on this booking (best-effort, post-commit).
    // Full refund → full reversal; partial refunds reverse proportionally
    // (proposed default — requires finance sign-off). Never throws.
    if (refund.bookingId) {
      try {
        const { reverseEarnedReward } = await import("../Services/rewardService.js");
        const paid = await Payment.findById(refund.paymentId).select("totalAmountPaise").lean().catch(() => null);
        const ratioBps =
          paid && paid.totalAmountPaise > 0
            ? Math.min(10000, Math.floor((refund.netRefundPaise * 10000) / paid.totalAmountPaise))
            : 10000;
        await reverseEarnedReward({ bookingId: refund.bookingId, refundId: refund._id, ratioBps });
      } catch (err) {
        console.error(`[Refund] reward reversal failed for refund ${refund._id}:`, err.message);
      }
    }

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
    // H9: attempts were already consumed atomically by the execution claim
    // above — do NOT increment again here (that would double-count and could
    // prematurely terminal-fail a retryable refund).
    refund.lastError = msg;

    if (statusCode >= 400 && statusCode < 500) {
      refund.status = "failed";
      await refund.save();
      // H9/H10: conditional release — racing paths cannot double-release.
      await releaseRefundReservation(refund.paymentId, refund.netRefundPaise);
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
      // H9: unrefundable source is terminal — release reservation (guarded)
      // and reverse any clawback, mirroring the failed path.
      await releaseRefundReservation(refund.paymentId, refund.netRefundPaise);
      if (refund.clawbackRequiredPaise > 0 && refund.technicianId) {
        await reverseClawback({ technicianId: refund.technicianId, refundId: refund._id });
      }
      await RefundOutbox.updateOne({ refundId: refund._id }, { $set: { status: "failed" } });
    } else {
      refund.status = "manual_review";
      await refund.save();
    }
    throw e;
  }
};

/**
 * C5 — REFUND STATUS MAP (authoritative, verified against this file).
 *
 * Persisted Refund.status values and their producers:
 *   pending_execution   ← createRefund (queued; RefundOutbox "new" unless dual-approval hold)
 *   processed           ← executeRefund success | reconcileRefunds (provider confirmed) | webhook
 *   failed              ← executeRefund 4xx-terminal | refundWorker attempts>=3 | reconcile (provider failed)
 *   retrying            ← retryRefund (admin re-queue; outbox upserted to "new")
 *   manual_review       ← executeRefund unexpected/provider error (admin must retryRefund)
 *   unrefundable_source ← executeRefund (cash/offline source — no provider reversal possible)
 * "initiated" is a LEGACY enum member: nothing in the current workflow ever
 * writes it. Reconcilers must NOT query for it.
 *
 * RefundOutbox.status: new → processing (atomic worker claim) → done | failed.
 * Provider calls carry Refund.idempotencyKey, and every ledger write uses a
 * per-refund idempotency key — repeats are safe by construction.
 */
const ACTIONABLE_REFUND_STATUSES = ["pending_execution", "retrying"];
const TERMINAL_REFUND_STATUSES = ["processed", "failed", "unrefundable_source"];
const RECONCILE_STALE_MS = 10 * 60 * 1000;
const OUTBOX_CLAIM_STALE_MS = 5 * 60 * 1000;

// Harmonize a "processing" outbox claim after executeRefund settled (or
// early-returned for an already-terminal refund) so no claim dangles forever.
const harmonizeOutboxClaim = async (refundId) => {
  const refund = await Refund.findById(refundId).select("status attempts").lean();
  if (!refund) {
    await RefundOutbox.updateOne(
      { refundId, status: "processing" },
      { $set: { status: "failed", lastError: "refund record not found" } }
    );
    return;
  }
  if (refund.status === "processed") {
    await RefundOutbox.updateOne({ refundId, status: "processing" }, { $set: { status: "done" } });
  } else if (["failed", "unrefundable_source", "manual_review"].includes(refund.status)) {
    await RefundOutbox.updateOne({ refundId, status: "processing" }, { $set: { status: "failed" } });
  }
};

export const refundWorker = async (limit = 25, deps = {}) => {
  const batch = await RefundOutbox.find({ status: "new" }).limit(limit).lean();
  let processed = 0;
  for (const item of batch) {
    // Atomic claim: exactly one worker (same process or another replica) can
    // own this item. Losers skip via the null return — no double execution.
    const claimed = await RefundOutbox.findOneAndUpdate(
      { _id: item._id, status: "new" },
      { $set: { status: "processing" } },
      { new: true }
    ).lean();
    if (!claimed) continue;
    processed += 1;
    try {
      // H9: the worker holds this item's `processing` claim — hand it to
      // executeRefund so no second mutex is taken for the same attempt.
      await executeRefund(item.refundId, { ...deps, ownedClaim: true });
      await harmonizeOutboxClaim(item.refundId);
      const refund = await Refund.findById(item.refundId).lean();
      if (refund && ACTIONABLE_REFUND_STATUSES.includes(refund.status) && refund.attempts >= 3) {
        // H10: attempts exhausted while still actionable (e.g. repeated
        // ambiguity). Park as manual_review — reservation stays intact for an
        // admin retry — and close the outbox (retryRefund requeues it).
        await Refund.updateOne(
          { _id: refund._id, status: { $in: ACTIONABLE_REFUND_STATUSES } },
          { $set: { status: "manual_review", lastError: "max execution attempts reached" } }
        );
        await RefundOutbox.updateOne({ refundId: item.refundId }, { $set: { status: "failed" } });
      } else if (refund && ACTIONABLE_REFUND_STATUSES.includes(refund.status)) {
        // Still actionable (e.g. a transient throw before any state change):
        // release the claim so a later tick retries. Provider idempotency key
        // makes the retried provider call safe.
        await RefundOutbox.updateOne(
          { refundId: item.refundId, status: "processing" },
          { $set: { status: "new" } }
        );
      }
    } catch (e) {
      console.error(`[RefundWorker] refund ${item.refundId}: ${e?.message || e}`);
      const refund = await Refund.findById(item.refundId).lean();
      if (refund && refund.attempts >= 3) {
        await RefundOutbox.updateOne({ refundId: item.refundId }, { $set: { status: "failed" } });
        // H10 invariant: the createRefund reservation is released ONLY when
        // the refund reached a terminal-failure status (failed /
        // unrefundable_source — both release on their own paths).
        // manual_review KEEPS its reservation so an admin retry needs no
        // re-reserve; releasing here would corrupt the retry accounting.
        // H9: guarded release — safe even if executeRefund already released.
        // 3A-1: reversal included — closes the crash window between
        // executeRefund's status save and its own reversal. reverseClawback
        // is marker-guarded and idempotent, so a repeat here is a no-op
        // when executeRefund already reversed.
        if (["failed", "unrefundable_source"].includes(refund.status)) {
          await releaseRefundReservation(refund.paymentId, refund.netRefundPaise);
          if (refund.clawbackRequiredPaise > 0 && refund.technicianId) {
            await reverseClawback({ technicianId: refund.technicianId, refundId: refund._id }).catch((e) =>
              console.error(`[RefundWorker] catch-path clawback reversal ${refund._id}: ${e?.message || e}`)
            );
          }
        }
      } else if (refund && ACTIONABLE_REFUND_STATUSES.includes(refund.status)) {
        await RefundOutbox.updateOne(
          { refundId: item.refundId, status: "processing" },
          { $set: { status: "new" } }
        );
      } else {
        await harmonizeOutboxClaim(item.refundId);
      }
    }
  }
  return { processed };
};

export const reconcileRefunds = async (deps = {}) => {
  const fetchProvider = deps.fetchProvider || fetchRazorpayRefund;
  const summary = { checked: 0, recovered: 0, requeued: 0 };
  const staleBefore = new Date(Date.now() - RECONCILE_STALE_MS);

  // 1. Provider-truth for refunds that reached the provider but whose DB row
  //    is still uncertain (interrupted between provider call and save).
  //    Only actionable states with a real provider id are eligible — terminal
  //    states (processed/failed/unrefundable_source/manual_review) are never
  //    re-processed here.
  const stale = await Refund.find({
    status: { $in: ACTIONABLE_REFUND_STATUSES },
    providerRefundId: { $ne: null },
    updatedAt: { $lte: staleBefore },
  })
    .select("_id providerRefundId status attempts")
    .limit(50)
    .lean();
  for (const r of stale) {
    summary.checked += 1;
    let rzp;
    try {
      rzp = await fetchProvider(r.providerRefundId);
    } catch (e) {
      // Provider unreachable — surfaced, NOT marked. Safe retry next tick.
      console.error(`[RefundReconcile] refund ${r._id}: ${e?.message || e}`);
      continue;
    }
    if (rzp.status === "processed" || rzp.status === "captured") {
      await Refund.updateOne(
        { _id: r._id, status: { $in: ACTIONABLE_REFUND_STATUSES } },
        { $set: { status: "processed", processedAt: new Date(), providerStatus: rzp.status } }
      );
      await CreditNote.updateOne({ refundId: r._id }, { $set: { declared: true } });
      await RefundOutbox.updateOne({ refundId: r._id }, { $set: { status: "done" } });
      summary.recovered += 1;
    } else if (rzp.status === "failed") {
      // Mirror the executeRefund terminal-failure path (reservation release +
      // clawback reversal) so the customer can retry through a fresh request.
      const ref = await Refund.findById(r._id);
      if (ref && ACTIONABLE_REFUND_STATUSES.includes(ref.status)) {
        ref.status = "failed";
        ref.attempts = (ref.attempts || 0) + 1;
        ref.lastError = "provider reported failed (reconciliation)";
        await ref.save();
        // H9: conditional release — safe under reconcile/worker races.
        await releaseRefundReservation(ref.paymentId, ref.netRefundPaise);
        if (ref.clawbackRequiredPaise > 0 && ref.technicianId) {
          await reverseClawback({ technicianId: ref.technicianId, refundId: ref._id }).catch((e) =>
            console.error(`[RefundReconcile] clawback reversal ${ref._id}: ${e?.message || e}`)
          );
        }
        await RefundOutbox.updateOne({ refundId: ref._id }, { $set: { status: "failed" } });
        summary.recovered += 1;
      }
    }
  }

  // 2. Orphaned actionable refunds: still pending/retrying but with no live
  //    outbox row (lost write) or a stale worker claim (crashed mid-execution).
  //    Requeue as "new" — the provider idempotency key keeps the retried call
  //    safe. Terminal outbox rows ("failed" after 3 attempts) are NEVER
  //    resurrected here; that path belongs to admin retryRefund.
  const actionable = await Refund.find({ status: { $in: ACTIONABLE_REFUND_STATUSES } })
    .select("_id updatedAt")
    .limit(100)
    .lean();
  const claimStaleBefore = new Date(Date.now() - OUTBOX_CLAIM_STALE_MS);
  for (const r of actionable) {
    const ob = await RefundOutbox.findOne({ refundId: r._id }).lean();
    if (!ob) {
      await RefundOutbox.create([{ refundId: r._id, status: "new" }]).catch((e) => {
        if (e?.code !== 11000) throw e; // another reconciler won the race
      });
      summary.requeued += 1;
    } else if (
      ob.status === "processing" &&
      ob.updatedAt &&
      ob.updatedAt <= claimStaleBefore
    ) {
      const released = await RefundOutbox.updateOne(
        { _id: ob._id, status: "processing" },
        { $set: { status: "new" } }
      );
      if (released.modifiedCount > 0) summary.requeued += 1;
    } else if (ob.status === "done") {
      // Interrupted between provider success and refund save: the refund is
      // still actionable but the outbox claims completion. Requeue so the
      // worker re-enters executeRefund idempotently via the provider key.
      const fresh = await Refund.findById(r._id).select("status updatedAt").lean();
      if (
        fresh &&
        ACTIONABLE_REFUND_STATUSES.includes(fresh.status) &&
        fresh.updatedAt &&
        fresh.updatedAt <= staleBefore
      ) {
        const requeued = await RefundOutbox.updateOne(
          { _id: ob._id, status: "done" },
          { $set: { status: "new" } }
        );
        if (requeued.modifiedCount > 0) summary.requeued += 1;
      }
    }
  }

  // 3. 3A-1 crash-window recovery for terminal-failure refunds: a crash
  //    between `refund.save(status=failed)` and the guarded release /
  //    marker-guarded reversal inside executeRefund (or the webhook path)
  //    leaves reservation held + clawback applied with NO throw for the
  //    worker to catch and NO actionable state for steps 1–2. Detect via
  //    the reversal markers: a terminal refund whose clawback steps lack
  //    markers never reversed. Both recovery ops are idempotent (guarded
  //    release + marker-guarded reversal), stale-gated (10m) so live
  //    executions are never touched, and audited. Skips when markers show
  //    reversal already ran.
  const crashCandidates = await Refund.find({
    status: { $in: ["failed", "unrefundable_source"] },
    clawbackRequiredPaise: { $gt: 0 },
    technicianId: { $ne: null },
    updatedAt: { $lte: staleBefore },
  })
    .select("_id paymentId technicianId netRefundPaise clawbackRequiredPaise")
    .limit(50)
    .lean();
  for (const r of crashCandidates) {
    const base = `rfd:${r._id}:clawback`;
    const markers = await WalletTransaction.countDocuments({
      technicianId: r.technicianId,
      idempotencyKey: { $regex: `^${base}:reversal` },
    });
    if (markers > 0) continue;
    await releaseRefundReservation(r.paymentId, r.netRefundPaise);
    await reverseClawback({ technicianId: r.technicianId, refundId: r._id }).catch((e) =>
      console.error(`[RefundReconcile] crash-window reversal ${r._id}: ${e?.message || e}`)
    );
    await writeAuditLog({
      action: "REFUND_CRASH_WINDOW_RECOVERED",
      targetType: "Refund",
      targetId: r._id,
      after: { netRefundPaise: r.netRefundPaise, clawbackRequiredPaise: r.clawbackRequiredPaise },
      reason: "Terminal-failure refund found without clawback reversal markers — recovered idempotently",
    });
    summary.recovered += 1;
  }

  return summary;
};

export const retryRefund = async (refundId, adminId) => {
  // H10: atomic retry claim + reservation re-establishment.
  //
  // Reservation invariant (enforced by every failure path): the
  // createRefund reservation (Payment.amountRefundedPaise += net) is released
  // if and only if the refund reached failed/unrefundable_source, and kept
  // while in manual_review. Therefore:
  //   - retry from failed ⇒ re-reserve atomically, guarded by the captured
  //     ceiling ($expr) so concurrent/duplicate retries can never over-refund;
  //   - retry from manual_review ⇒ reservation intact, no re-reserve.
  // The status claim itself is conditional (failed/manual_review → retrying),
  // so concurrent admin retries collapse to a single winner (409 for losers).
  const pre = await Refund.findOneAndUpdate(
    { _id: refundId, status: { $in: ["failed", "manual_review"] }, attempts: { $lt: 3 } },
    { $set: { status: "retrying", lastError: null } },
    { new: false }
  );
  if (!pre) {
    const current = await Refund.findById(refundId).lean();
    if (!current) throw RefundError("REFUND_NOT_FOUND", 404);
    if ((current.attempts || 0) >= 3) throw RefundError("MAX_ATTEMPTS_EXCEEDED", 409);
    throw RefundError("REFUND_IN_FLIGHT", 409);
  }

  if (pre.status === "failed") {
    const payment = await Payment.findById(pre.paymentId).lean();
    if (!payment) {
      await Refund.updateOne({ _id: refundId, status: "retrying" }, { $set: { status: "failed" } });
      throw RefundError("PAYMENT_NOT_FOUND", 404);
    }
    const captured = toPaise(payment.capturedAmountPaise ?? payment.totalAmountPaise);
    const reReserved = await Payment.findOneAndUpdate(
      {
        _id: pre.paymentId,
        $expr: { $lte: [{ $add: ["$amountRefundedPaise", pre.netRefundPaise] }, captured] },
      },
      { $inc: { amountRefundedPaise: pre.netRefundPaise } },
      { new: true }
    );
    if (!reReserved) {
      // Not enough eligible amount left — roll the claim back, keep auditable.
      await Refund.updateOne({ _id: refundId, status: "retrying" }, { $set: { status: "failed" } });
      throw RefundError("REFUND_EXCEEDS_CAPTURED", 422);
    }
  }

  await RefundOutbox.updateOne(
    { refundId },
    { $set: { status: "new", nextAttemptAt: new Date() } },
    { upsert: true }
  );
  await writeAuditLog({
    action: "REFUND_RETRY_QUEUED",
    targetType: "Refund",
    targetId: refundId,
    actor: adminId,
    actorRole: "Admin",
    after: { priorStatus: pre.status, reReserved: pre.status === "failed" },
  });
  return Refund.findById(refundId);
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
    // H10: provider-reported failure is terminal for this attempt — mirror the
    // executeRefund failure path exactly (guarded reservation release +
    // clawback reversal) so the failed ⇒ released invariant holds.
    refund.status = "failed";
    await refund.save();
    await releaseRefundReservation(refund.paymentId, refund.netRefundPaise);
    if (refund.clawbackRequiredPaise > 0 && refund.technicianId) {
      await reverseClawback({ technicianId: refund.technicianId, refundId: refund._id });
    }
    await RefundOutbox.updateOne({ refundId: refund._id }, { $set: { status: "failed" } });
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
