import mongoose from "mongoose";

import Payment from "../Schemas/Payment.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import Quotation from "../Schemas/Quotation.js";
import ReconciliationException from "../Schemas/ReconciliationException.js";
import { settleBookingEarningsIfEligible } from "./settlement.js";
import { writeAuditLog } from "./audit.js";
import { postPaymentLedgerEntries } from "./ledger.js";
import { toPaise } from "./money.js";

/**
 * 🔄 PAYMENT STATE TRANSITIONS — the ONLY place a Payment changes from
 * pending → success/failed. Shared by:
 *   - POST /payment/verify            (fast path, signature verified)
 *   - POST /payment/webhook/razorpay  (AUTHORITATIVE, HMAC verified)
 *   - Reconciliation cron             (backstop)
 *   - PUT /payment/:id/status         (Admin/Owner manual override, audited)
 *
 * Whichever arrives first wins; later arrivals are idempotent no-ops.
 *
 * On success, the platform ledger entries are created ONCE (idempotent keys):
 *   payment:<id>:customer-payment   (credit, gross)
 *   payment:<id>:liability          (debit, technician earning liability)
 *   payment:<id>:commission         (credit, platform revenue)
 *
 * Provider captured amount is validated in paise; any mismatch flags the
 * payment as manual_review and writes a reconciliation exception.
 */

const isTransactionUnsupported = (err) => {
  const msg = String(err?.message || "");
  return (
    msg.includes("replica set") ||
    msg.includes("Transaction") ||
    msg.includes("mongos")
  );
};

const settleAfterCommit = async ({ bookingId, itemType, source }) => {
  if (itemType === "service") {
    try {
      const result = await settleBookingEarningsIfEligible(bookingId);
      if (!result.settled) {
        console.warn(
          `settleAfterCommit: settlement not completed for booking ${bookingId}. Reason: ${result.reason}`
        );
      }
      return result;
    } catch (err) {
      console.error(
        `settleAfterCommit: settlement failed for booking ${bookingId}. Error: ${err.message}`
      );
      return { settled: false, reason: "settlement_error", error: err.message };
    }
  }
};

/**
 * Reconcile the provider-captured amount against Payment.totalAmountPaise.
 * @returns {{ok: boolean, mismatch: boolean, capturedAmountPaise: number|null}}
 */
export const verifyCapturedAmount = (payment, providerAmountPaise) => {
  const captured = providerAmountPaise != null ? toPaise(providerAmountPaise) : null;
  if (captured == null) {
    return { ok: true, mismatch: false, capturedAmountPaise: null };
  }
  const expected = toPaise(payment?.totalAmountPaise ?? payment?.totalAmount);
  return {
    ok: captured === expected,
    mismatch: captured !== expected,
    capturedAmountPaise: captured,
  };
};

/**
 * Write a reconciliation exception (deduped by fingerprint).
 */
export const raiseReconciliationException = async ({ code, severity = "warning", details = null, session = null }) => {
  const fingerprint = `${code}:${details?.bookingId || ""}:${details?.paymentId || ""}:${details?.withdrawalId || ""}`;
  try {
    await ReconciliationException.updateOne(
      { fingerprint },
      { $setOnInsert: { code, severity, details, fingerprint } },
      { upsert: true, session: session || undefined }
    );
  } catch (e) {
    console.error("[ReconciliationException] write failed:", e.message);
  }
};

const applySuccess = async ({ payment, providerPaymentId, razorpaySignature, source, actor, reason, session }) => {
  const before = payment.toObject();
  payment.status = "success";
  if (providerPaymentId) payment.providerPaymentId = providerPaymentId;
  if (razorpaySignature) payment.providerSignature = razorpaySignature;
  payment.verifiedAt = new Date();
  payment.failureReason = null;
  await payment.save(session ? { session } : {});

  const updatePayload = {
    paymentStatus: "paid",
    paidAmount: toPaise(payment.totalAmountPaise) / 100 || payment.totalAmount || 0,
    paidAmountPaise: toPaise(payment.totalAmountPaise ?? (payment.totalAmount || 0) * 100),
  };
  if (providerPaymentId) updatePayload.paymentProviderPaymentId = providerPaymentId;
  if (payment.providerOrderId) updatePayload.paymentOrderId = payment.providerOrderId;
  if (payment._id) updatePayload.paymentId = payment._id;
  if (payment.provider) updatePayload.paymentProvider = payment.provider;
  if (payment.mode) updatePayload.paymentMode = payment.mode;

  const sResult = await ServiceBooking.updateOne(
    { _id: payment.bookingId },
    { $set: updatePayload },
    session ? { session } : {}
  );
  if (sResult.matchedCount === 0) {
    const pbResult = await ProductBooking.updateOne(
      { _id: payment.bookingId },
      { $set: updatePayload },
      session ? { session } : {}
    );

    if (pbResult.matchedCount > 0) {
      // Also update linked Quotation if this ProductBooking has a quotationId
      const pb = await ProductBooking.findById(payment.bookingId).select("quotationId paymentGroupId").session(session || undefined);
      if (pb?.quotationId) {
        await Quotation.updateOne(
          { _id: pb.quotationId },
          { $set: { paymentStatus: "paid" } },
          session ? { session } : {}
        );
        // Sync any sibling ProductBookings sharing the same quotationId
        await ProductBooking.updateMany(
          { quotationId: pb.quotationId, _id: { $ne: pb._id } },
          { $set: updatePayload },
          session ? { session } : {}
        );
      }
    } else {
      // Direct quotation payment fallback: payment.bookingId is a Quotation._id
      const qResult = await Quotation.updateOne(
        { _id: payment.bookingId },
        { $set: { paymentStatus: "paid" } },
        session ? { session } : {}
      );
      if (qResult.matchedCount > 0) {
        // Update all ProductBookings linked to this Quotation
        await ProductBooking.updateMany(
          { quotationId: payment.bookingId },
          { $set: updatePayload },
          session ? { session } : {}
        );
      }
    }
  }

  // 🏦 Platform ledger — idempotent per payment
  const ledger = await postPaymentLedgerEntries({ payment, session });
  if (!ledger.created) {
    console.warn(`[PaymentTransition] ledger entries already posted for payment ${payment._id}`);
  }

  await writeAuditLog({
    actor: actor?.userId || null,
    actorRole: actor?.role || null,
    action: "PAYMENT_MARKED_SUCCESS",
    targetType: "Payment",
    targetId: payment._id,
    before: { status: before.status, failureReason: before.failureReason },
    after: {
      status: "success",
      providerPaymentId: providerPaymentId || null,
      totalAmountPaise: toPaise(payment.totalAmountPaise),
    },
    reason,
    metadata: { source, ledgerKeys: ledger.keys },
    session: session || null,
  });

  return payment;
};

/**
 * Transition a payment to success (idempotent, transactional).
 *
 * @param {string} paymentId
 * @param {object} opts
 * @param {string} [opts.providerPaymentId]
 * @param {string} [opts.razorpaySignature]
 * @param {number|null} [opts.providerAmountPaise] captured amount from provider
 * @param {string} opts.source
 * @param {object} [opts.actor]
 * @param {string} [opts.reason]
 * @returns {Promise<{alreadyProcessed: boolean, payment: object|null, amountMismatch: boolean}>}
 */
export const markPaymentSucceeded = async (
  paymentId,
  { providerPaymentId = null, razorpaySignature = null, providerAmountPaise = null, source, actor = null, reason = null }
) => {
  const doNonTransactional = async () => {
    const payment = await Payment.findById(paymentId);
    if (!payment) throw Object.assign(new Error("Payment not found"), { statusCode: 404 });
    if (payment.status === "success") {
      // Late webhook with a mismatched capture must still flag, even if the
      // fast path already succeeded (verify has no amount; webhook is authoritative).
      const { ok, mismatch, capturedAmountPaise } = verifyCapturedAmount(payment, providerAmountPaise);
      if (mismatch) {
        await raiseReconciliationException({
          code: "PAYMENT_AMOUNT_MISMATCH",
          severity: "critical",
          details: { bookingId: payment.bookingId, paymentId: payment._id, capturedAmountPaise, expectedPaise: toPaise(payment.totalAmountPaise) },
        });
      }
      return { alreadyProcessed: true, payment, amountMismatch: mismatch };
    }

    // Amount guard
    const { ok, mismatch, capturedAmountPaise } = verifyCapturedAmount(payment, providerAmountPaise);
    if (mismatch) {
      payment.status = "manual_review";
      payment.failureReason = `Provider captured ${capturedAmountPaise} paise but expected ${toPaise(payment.totalAmountPaise)} paise`;
      await payment.save();
      await raiseReconciliationException({
        code: "PAYMENT_AMOUNT_MISMATCH",
        severity: "critical",
        details: { bookingId: payment.bookingId, paymentId: payment._id, capturedAmountPaise, expectedPaise: toPaise(payment.totalAmountPaise) },
      });
      return { alreadyProcessed: false, payment, amountMismatch: true };
    }

    payment.capturedAmountPaise = capturedAmountPaise ?? toPaise(payment.totalAmountPaise);
    await applySuccess({ payment, providerPaymentId, razorpaySignature, source, actor, reason, session: null });
    return { alreadyProcessed: false, payment, amountMismatch: false };
  };

  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const payment = await Payment.findById(paymentId).session(session);
      if (!payment) throw Object.assign(new Error("Payment not found"), { statusCode: 404 });

      if (payment.status === "success") {
        // Late webhook amount check (see non-transactional path above)
        const { mismatch, capturedAmountPaise } = verifyCapturedAmount(payment, providerAmountPaise);
        if (mismatch) {
          await raiseReconciliationException({
            code: "PAYMENT_AMOUNT_MISMATCH",
            severity: "critical",
            details: { bookingId: payment.bookingId, paymentId: payment._id, capturedAmountPaise, expectedPaise: toPaise(payment.totalAmountPaise) },
            session,
          });
        }
        result = { alreadyProcessed: true, payment, amountMismatch: mismatch };
        return;
      }

      const { ok, mismatch, capturedAmountPaise } = verifyCapturedAmount(payment, providerAmountPaise);
      if (mismatch) {
        payment.status = "manual_review";
        payment.failureReason = `Provider captured ${capturedAmountPaise} paise but expected ${toPaise(payment.totalAmountPaise)} paise`;
        await payment.save({ session });
        await raiseReconciliationException({
          code: "PAYMENT_AMOUNT_MISMATCH",
          severity: "critical",
          details: { bookingId: payment.bookingId, paymentId: payment._id, capturedAmountPaise, expectedPaise: toPaise(payment.totalAmountPaise) },
          session,
        });
        result = { alreadyProcessed: false, payment, amountMismatch: true };
        return;
      }

      payment.capturedAmountPaise = capturedAmountPaise ?? toPaise(payment.totalAmountPaise);
      await applySuccess({ payment, providerPaymentId, razorpaySignature, source, actor, reason, session });
      result = { alreadyProcessed: false, payment, amountMismatch: false };
    });
  } catch (txErr) {
    if (isTransactionUnsupported(txErr)) {
      result = await doNonTransactional();
    } else {
      throw txErr;
    }
  } finally {
    session.endSession();
  }

  if (result && result.payment && !result.alreadyProcessed && !result.amountMismatch) {
    await settleAfterCommit({
      bookingId: result.payment.bookingId,
      itemType: result.payment.itemType || "service",
      source,
    });
  }

  return result;
};

/**
 * Transition a payment to failed (idempotent, transactional).
 */
export const markPaymentFailed = async (
  paymentId,
  { failureReason = null, source, actor = null, reason = null, session: outerSession = null }
) => {
  const doNonTransactional = async () => {
    const payment = await Payment.findById(paymentId);
    if (!payment) throw Object.assign(new Error("Payment not found"), { statusCode: 404 });
    if (payment.status === "success") {
      return { alreadyProcessed: true, payment };
    }
    if (payment.status === "failed" && payment.failureReason === failureReason) {
      return { alreadyProcessed: true, payment };
    }

    const before = payment.toObject();
    payment.status = "failed";
    if (failureReason) payment.failureReason = failureReason;
    await payment.save();

    await writeAuditLog({
      actor: actor?.userId || null,
      actorRole: actor?.role || null,
      action: "PAYMENT_MARKED_FAILED",
      targetType: "Payment",
      targetId: payment._id,
      before: { status: before.status },
      after: { status: "failed", failureReason: failureReason || null },
      reason,
      metadata: { source },
      session: null,
    });

    return { alreadyProcessed: false, payment };
  };

  if (outerSession) {
    const payment = await Payment.findById(paymentId).session(outerSession);
    if (!payment) throw Object.assign(new Error("Payment not found"), { statusCode: 404 });
    if (payment.status === "success") return { alreadyProcessed: true, payment };

    const before = payment.toObject();
    payment.status = "failed";
    if (failureReason) payment.failureReason = failureReason;
    await payment.save({ session: outerSession });

    await writeAuditLog({
      actor: actor?.userId || null,
      actorRole: actor?.role || null,
      action: "PAYMENT_MARKED_FAILED",
      targetType: "Payment",
      targetId: payment._id,
      before: { status: before.status },
      after: { status: "failed", failureReason: failureReason || null },
      reason,
      metadata: { source },
      session: outerSession,
    });

    return { alreadyProcessed: false, payment };
  }

  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        const payment = await Payment.findById(paymentId).session(session);
        if (!payment) throw Object.assign(new Error("Payment not found"), { statusCode: 404 });
        if (payment.status === "success") {
          result = { alreadyProcessed: true, payment };
          return;
        }

        const before = payment.toObject();
        payment.status = "failed";
        if (failureReason) payment.failureReason = failureReason;
        await payment.save({ session });

        await writeAuditLog({
          actor: actor?.userId || null,
          actorRole: actor?.role || null,
          action: "PAYMENT_MARKED_FAILED",
          targetType: "Payment",
          targetId: payment._id,
          before: { status: before.status },
          after: { status: "failed", failureReason: failureReason || null },
          reason,
          metadata: { source },
          session,
        });

        result = { alreadyProcessed: false, payment };
      });
    } catch (txErr) {
      if (isTransactionUnsupported(txErr)) {
        result = await doNonTransactional();
      } else {
        throw txErr;
      }
    }
    return result;
  } finally {
    session.endSession();
  }
};