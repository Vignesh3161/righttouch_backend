import mongoose from "mongoose";

import Payment from "../Schemas/Payment.js";
import PaymentEvent from "../Schemas/PaymentEvent.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import Service from "../Schemas/Service.js";
import Product from "../Schemas/Product.js";
import ProductBooking from "../Schemas/ProductBooking.js";

import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  verifyWebhookSignature,
} from "../Utils/razorpay.js";
import { toPaise } from "../Utils/money.js";
import {
  markPaymentSucceeded,
  markPaymentFailed,
} from "../Utils/paymentTransitions.js";
import { settleBookingEarningsIfEligible } from "../Utils/settlement.js";
import { writeAuditLog } from "../Utils/audit.js";
import { sendPushNotification } from "../Utils/sendNotification.js";

/* ================= HELPERS ================= */

const ok = (res, status, message, result = {}) =>
  res.status(status).json({ success: true, message, result });

const fail = (res, status, message, result = {}) =>
  res.status(status).json({ success: false, message, result });

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isPrivilegedRole = (role) => ["Admin", "Owner"].includes(role);

const requireAdminOrOwner = (req, res) => {
  if (!isPrivilegedRole(req.user?.role)) {
    fail(res, 403, "Admin/Owner access only");
    return false;
  }
  return true;
};

/**
 * Notify customer + technician once a payment actually transitions to success
 * (never on idempotent duplicates). Push + socket; failures are logged only.
 */
const notifyPaymentSucceeded = async (req, payment) => {
  try {
    const booking = await ServiceBooking.findById(payment.bookingId)
      .select("customerId technicianId")
      .lean();
    if (!booking) return;

    const io = req?.io;
    if (booking.customerId) {
      await sendPushNotification(booking.customerId.toString(), {
        title: "Payment Successful",
        body: `Your payment of ₹${payment.totalAmount} for the service is confirmed. Thank you!`,
        data: { bookingId: payment.bookingId?.toString(), type: "PAYMENT_SUCCESS" },
      });
      if (io) {
        io.to(`customer_${booking.customerId}`).emit("payment_success", {
          bookingId: payment.bookingId,
          amount: payment.totalAmount,
          status: "success",
        });
      }
    }
    if (booking.technicianId) {
      await sendPushNotification(booking.technicianId.toString(), {
        title: "Payment Received",
        body: `Payment of ₹${payment.totalAmount} received. Earnings credited to your wallet.`,
        data: { bookingId: payment.bookingId?.toString(), type: "PAYMENT_RECEIVED" },
      });
      if (io) {
        io.to(`technician_${booking.technicianId}`).emit("payment_received", {
          bookingId: payment.bookingId,
          amount: payment.totalAmount,
          status: "success",
        });
      }
    }
  } catch (err) {
    console.error("notifyPaymentSucceeded error:", err.message);
  }
};

/* =====================================================
   1️⃣ CREATE PAYMENT ORDER  (Phase 1 — Collection)
   Commission is computed SERVER-SIDE here — never trusted
   from the client, never recomputed after payout.
===================================================== */

export const createPaymentOrder = async (req, res) => {
  try {
    const isPrivileged = isPrivilegedRole(req.user?.role);
    if (req.user?.role !== "Customer" && !isPrivileged) {
      return fail(res, 403, "Customer/Admin access only");
    }

    if (!req.user?.userId && !isPrivileged) {
      return fail(res, 401, "Unauthorized");
    }

    const { bookingId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "Valid bookingId required");
    }

    let booking = await ServiceBooking.findById(bookingId);
    let itemType = "service";

    if (!booking) {
      booking = await ProductBooking.findById(bookingId);
      itemType = "product";
    }

    if (!booking) return fail(res, 404, "Booking not found");

    if (!isPrivileged) {
      if (!booking.customerId) {
        return fail(res, 500, "Booking missing customerId");
      }
      if (String(booking.customerId) !== String(req.user.userId)) {
        return fail(res, 403, "Access denied");
      }
    }

    // Already-paid guard — money already captured for this booking
    const existingPayment = await Payment.findOne({ bookingId });
    if (
      booking.paymentStatus === "paid" ||
      (existingPayment && existingPayment.status === "success")
    ) {
      return fail(res, 409, "Booking already paid", {
        paymentId: existingPayment?._id,
        orderId: existingPayment?.providerOrderId || null,
      });
    }

    // Status gate for services only — payment is allowed only AFTER the
    // service has been completed (pay-at-completion flow).
    if (itemType === "service") {
      if (booking.status !== "completed") {
        return fail(
          res,
          400,
          `Payment allowed only after service completion (current status: ${booking.status})`
        );
      }
    }

    let payableAmount;
    let snapshot;

    const bookingSnapshot = booking.financialSnapshot || {};

    if (itemType === "service") {
      snapshot = bookingSnapshot;
      payableAmount = toMoney(booking.baseAmount);
    } else {
      snapshot = bookingSnapshot;
      payableAmount = toMoney(booking.amount);
    }

    if (
      !snapshot ||
      snapshot.totalAmountPaise == null ||
      snapshot.calculationVersion == null
    ) {
      // A booking created before the snapshot model — refuse and flag instead
      // of silently computing money here. Money is resolved ONCE at booking.
      return fail(
        res,
        409,
        "Booking has no financial snapshot. Re-book or run the backfill migration.",
        { bookingId }
      );
    }

    const snapshotTotalPaise = toPaise(snapshot.totalAmountPaise);
    if (snapshotTotalPaise < 100) {
      return fail(res, 400, "Minimum payment amount is ₹1");
    }

    // ── Copy the booking snapshot into Payment. NEVER recompute commission. ──
    let payment = existingPayment;
    if (!payment) {
      payment = await Payment.create({
        bookingId,
        itemType,
        idempotencyKey: `payment-booking:${bookingId}`,
        baseAmountPaise: snapshot.baseAmountPaise ?? 0,
        totalAmountPaise: snapshotTotalPaise,
        commissionPercentage: snapshot.commissionPercentage ?? 0,
        commissionAmountPaise: snapshot.commissionAmountPaise ?? 0,
        technicianAmountPaise: snapshot.technicianAmountPaise ?? 0,
        gstAmountPaise: snapshot.gstAmountPaise ?? 0,
        tipAmountPaise: snapshot.tipAmountPaise ?? 0,
        commissionRuleSource: snapshot.commissionRuleSource ?? null,
        commissionRuleId: snapshot.commissionRuleId ?? null,
        calculationVersion: snapshot.calculationVersion ?? 1,
        // Legacy rupee mirrors
        serviceAmount: toPaise(snapshot.baseAmountPaise) / 100,
        baseAmount: toPaise(snapshot.baseAmountPaise) / 100,
        gstPercentage: snapshot.gstPercentage ?? 0,
        gstAmount: toPaise(snapshot.gstAmountPaise) / 100,
        tipAmount: toPaise(snapshot.tipAmountPaise) / 100,
        totalAmount: snapshotTotalPaise / 100,
        commissionAmount: toPaise(snapshot.commissionAmountPaise) / 100,
        technicianAmount: toPaise(snapshot.technicianAmountPaise) / 100,
        provider: "razorpay",
        mode: "online",
        currency: "INR",
      });
    } else if (payment.status !== "success") {
      // 🔒 SNAPSHOT GUARD (Section 5): the Payment must equal the Booking.
      // If commission or totals drifted, STOP and create a reconciliation error.
      const mismatches = [];
      if (toPaise(payment.totalAmountPaise) !== snapshotTotalPaise) mismatches.push("totalAmountPaise");
      if (toPaise(payment.commissionAmountPaise) !== toPaise(snapshot.commissionAmountPaise)) mismatches.push("commissionAmountPaise");
      if (toPaise(payment.technicianAmountPaise) !== toPaise(snapshot.technicianAmountPaise)) mismatches.push("technicianAmountPaise");

      if (mismatches.length > 0) {
        await writeAuditLog({
          action: "PAYMENT_SNAPSHOT_MISMATCH",
          targetType: "Payment",
          targetId: payment._id,
          before: {
            totalAmountPaise: payment.totalAmountPaise,
            commissionAmountPaise: payment.commissionAmountPaise,
            technicianAmountPaise: payment.technicianAmountPaise,
          },
          after: {
            totalAmountPaise: snapshotTotalPaise,
            commissionAmountPaise: toPaise(snapshot.commissionAmountPaise),
            technicianAmountPaise: toPaise(snapshot.technicianAmountPaise),
          },
          metadata: { bookingId, fields: mismatches },
          reason: "Financial snapshot drift between booking and payment — manual reconciliation required",
        });
        payment.status = "manual_review";
        payment.failureReason = `Snapshot mismatch on: ${mismatches.join(", ")}`;
        await payment.save();
        return fail(res, 409, "Financial snapshot mismatch — payment flagged for manual review", {
          paymentId: payment._id,
          mismatches,
        });
      }

      // Safe to re-issue a fresh provider order id for this unchanged amount.
      payment.providerOrderId = null;
      payment.providerPaymentId = null;
      await payment.save();
    }

    booking.paymentProvider = "razorpay";
    booking.paymentId = payment._id;

    if (!payment.providerOrderId) {
      const order = await createRazorpayOrder({
        amountInPaisa: snapshotTotalPaise,
        currency: "INR",
        receipt: `booking_${bookingId}`,
        notes: {
          bookingId: bookingId?.toString(),
          customerId: booking?.customerId?.toString(),
          itemType,
          paymentId: payment._id?.toString(),
        },
      });

      payment.providerOrderId = order.id;
      await payment.save();

      booking.paymentOrderId = order.id;
    }

    await booking.save();

    // Amount is returned in PAISE (as Razorpay Checkout SDK expects).
    return ok(res, 201, "Payment order created", {
      keyId: (process.env.RAZORPAY_KEY_ID || "").trim(),
      orderId: payment.providerOrderId,
      amount: snapshotTotalPaise,
      amountInRupees: snapshotTotalPaise / 100,
      currency: payment.currency,
      paymentId: payment._id,
      split: {
        serviceAmountPaise: toPaise(snapshot.baseAmountPaise),
        gstPercentage: snapshot.gstPercentage ?? 0,
        gstAmountPaise: toPaise(snapshot.gstAmountPaise),
        tipAmountPaise: toPaise(snapshot.tipAmountPaise),
        commissionPercentage: snapshot.commissionPercentage ?? 0,
        commissionAmountPaise: toPaise(snapshot.commissionAmountPaise),
        technicianAmountPaise: toPaise(snapshot.technicianAmountPaise),
        totalAmountPaise: snapshotTotalPaise,
        ruleSource: snapshot.commissionRuleSource ?? null,
        calculationVersion: snapshot.calculationVersion ?? 1,
      },
    });
  } catch (err) {
    if (res.headersSent) return;
    return fail(res, err.statusCode || 500, err.message, err.details);
  }
};

/* =====================================================
   2️⃣ VERIFY PAYMENT  (fast path — NOT authoritative)
   Webhook is the source of truth; this is a convenience
   that gives the customer instant feedback. Idempotent.
===================================================== */

export const verifyPayment = async (req, res) => {
  try {
    const isPrivileged = isPrivilegedRole(req.user?.role);
    if (req.user?.role !== "Customer" && !isPrivileged) {
      return fail(res, 403, "Customer/Admin access only");
    }

    const {
      bookingId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !bookingId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return fail(res, 400, "Missing payment details");
    }

    const payment = await Payment.findOne({ bookingId }).lean();
    if (!payment) return fail(res, 404, "Payment not found");

    if (payment.providerOrderId !== razorpay_order_id) {
      return fail(res, 400, "Order mismatch");
    }

    // Ownership check — customers may only verify their own booking
    if (!isPrivileged) {
      let owned = false;
      if (payment.itemType === "product") {
        const pb = await ProductBooking.findById(payment.bookingId)
          .select("customerId")
          .lean();
        owned = pb && String(pb.customerId) === String(req.user.userId);
      } else {
        const sb = await ServiceBooking.findById(payment.bookingId)
          .select("customerId")
          .lean();
        owned = sb && String(sb.customerId) === String(req.user.userId);
      }
      if (!owned) return fail(res, 403, "Access denied");
    }

    // HMAC signature verification (server-side, never client-asserted)
    if (
      !verifyRazorpaySignature({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
      })
    ) {
      await markPaymentFailed(payment._id, {
        failureReason: "Invalid signature",
        source: "verify",
      });
      return fail(res, 400, "Verification failed", { status: "failed" });
    }

    const result = await markPaymentSucceeded(payment._id, {
      providerPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      source: "verify",
    });

    if (result.alreadyProcessed) {
      return ok(res, 200, "Payment already verified", {
        status: "success",
        bookingId,
        paidAmount: payment.totalAmount,
      });
    }

    await notifyPaymentSucceeded(req, payment);

    // Fetch technician wallet balance after settlement
    let technicianWalletBalance = null;
    if (payment.itemType === "service") {
      const booking = await ServiceBooking.findById(bookingId)
        .select("technicianId")
        .lean();
      if (booking?.technicianId) {
        const TechnicianProfile = (await import("../Schemas/TechnicianProfile.js")).default;
        const techProfile = await TechnicianProfile.findById(booking.technicianId)
          .select("walletBalance")
          .lean();
        technicianWalletBalance = techProfile?.walletBalance || 0;
      }
    }

    return ok(res, 200, "Payment verified successfully", {
      status: "success",
      bookingId,
      paidAmount: payment.totalAmount,
      technicianWalletBalance,
    });
  } catch (err) {
    if (res.headersSent) return;
    return fail(res, err.statusCode || 500, err.message);
  }
};

/* =====================================================
   3️⃣ RAZORPAY WEBHOOK  (AUTHORITATIVE)
   Signature verified over rawBody, deduped by eventId,
   and drives the actual state transition. Whatever of
   /verify vs webhook arrives first wins — the other is
   an idempotent no-op.
===================================================== */

export const razorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];

    if (!verifyWebhookSignature(req.rawBody, signature)) {
      return fail(res, 400, "Invalid webhook signature");
    }

    const event = req.body;

    // Dedupe: unique eventId — the insert is the lock
    let eventRecord;
    try {
      eventRecord = await PaymentEvent.create({
        provider: "razorpay",
        eventId: event.id,
        eventType: event.event,
        payload: event,
      });
    } catch (e) {
      if (e?.code === 11000) {
        return ok(res, 200, "Already processed");
      }
      throw e;
    }

    const entity = event.payload?.entity || event.payload?.payment || {};

    // Event-specific shape: payment events carry payment.order_id,
    // order events carry the order id directly on entity.id.
    let orderId = null;
    let providerPaymentId = null;

    if (event.event === "payment.captured" || event.event === "payment.failed") {
      orderId = entity?.order_id || null;
      providerPaymentId = entity?.id || null;
    } else if (event.event === "order.paid" || event.event === "order.pending") {
      orderId = entity?.id || null;
    }

    if (!orderId) {
      // Nothing actionable without an order reference
      return ok(res, 200, "Webhook received");
    }

    const payment = await Payment.findOne({ providerOrderId: orderId }).lean();

    if (event.event === "payment.captured") {
      if (!payment) return ok(res, 200, "Payment not found for order");

      // 🔒 Amount guard — never book a partial/mismatched capture as success.
      // entity.amount is in PAISE; markPaymentSucceeded compares it against
      // Payment.totalAmountPaise and flags manual_review on mismatch.
      const transition = await markPaymentSucceeded(payment._id, {
        providerPaymentId,
        providerAmountPaise: toMoney(entity?.amount),
        source: "webhook",
      });
      eventRecord.eventType = `${eventRecord.eventType}:applied`;
      await eventRecord.save().catch(() => {});
      if (transition.amountMismatch) {
        return ok(res, 200, "Amount mismatch — manual review required");
      }
      if (!transition.alreadyProcessed) {
        await notifyPaymentSucceeded(req, payment);
      }
      return ok(res, 200, "Payment captured");
    }

    if (event.event === "payment.failed") {
      if (!payment) return ok(res, 200, "Payment not found for order");

      await markPaymentFailed(payment._id, {
        failureReason: entity?.error_description || entity?.error?.description || "Razorpay reported failure",
        source: "webhook",
      });
      eventRecord.eventType = `${eventRecord.eventType}:applied`;
      await eventRecord.save().catch(() => {});
      return ok(res, 200, "Payment failed recorded");
    }

    // order.paid / order.pending / checkout events — informational only;
    // the authoritative state change comes from payment.captured.
    return ok(res, 200, "Webhook received");
  } catch (err) {
    if (res.headersSent) return;
    return fail(res, err.statusCode || 500, err.message);
  }
};

/* =====================================================
   4️⃣ MANUAL STATUS UPDATE  (Admin/Owner, audited)
   The ONLY endpoint that can mutate payment state by
   hand. Requires a reason; writes before/after to AuditLog.
===================================================== */

export const updatePaymentStatus = async (req, res) => {
  try {
    if (!requireAdminOrOwner(req, res)) return;

    const { id } = req.params;
    const { status, failureReason, reason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "Invalid payment ID");
    }

    if (!["pending", "success", "failed"].includes(status)) {
      return fail(res, 400, "Invalid status");
    }

    if (!reason || !String(reason).trim()) {
      return fail(res, 400, "A reason is required for manual status changes");
    }

    const payment = await Payment.findById(id);
    if (!payment) return fail(res, 404, "Payment not found");

    const before = payment.toObject();
    const actor = { userId: req.user.userId, role: req.user.role };

    let finalStatus;
    if (status === "success") {
      if (payment.status === "success") {
        return ok(res, 200, "Payment already in requested state", {
          paymentId: payment._id,
          status: payment.status,
          settlementTriggered: false,
        });
      }
      const transition = await markPaymentSucceeded(payment._id, {
        source: "manual",
        actor,
        reason,
      });
      finalStatus = transition.payment?.status || "success";
    } else if (status === "failed") {
      const transition = await markPaymentFailed(payment._id, {
        failureReason: failureReason || "Manual override by admin",
        source: "manual",
        actor,
        reason,
      });
      finalStatus = transition.payment?.status || "failed";
    } else {
      // pending — allow rescue of wrongly-failed payments
      if (payment.status === "failed") {
        payment.status = "pending";
        payment.failureReason = null;
        // 🔄 Reset reconciliation counters so the cron treats this as a
        // fresh order instead of instantly re-marking it failed.
        payment.reconciliationAttempts = 0;
        payment.lastReconciliationAt = null;
        await payment.save();
      }
      finalStatus = payment.status;
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "PAYMENT_STATUS_MANUAL_UPDATE",
      targetType: "Payment",
      targetId: payment._id,
      before: { status: before.status, failureReason: before.failureReason },
      after: { status },
      reason,
    });

    let settlementTriggered = false;
    if (status === "success") {
      const settlement = await settleBookingEarningsIfEligible(payment.bookingId);
      settlementTriggered = settlement.settled;
      await notifyPaymentSucceeded(req, payment);
    }

    return ok(res, 200, "Payment status updated", {
      paymentId: payment._id,
      status: finalStatus,
      settlementTriggered,
    });
  } catch (err) {
    if (res.headersSent) return;
    return fail(res, err.statusCode || 500, err.message);
  }
};

/* =====================================================
   5️⃣ GET PAYMENT BY BOOKING  (Customer owns / Admin-Owner)
===================================================== */

export const getPaymentByBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "Valid bookingId required");
    }

    const payment = await Payment.findOne({ bookingId }).lean();
    if (!payment) return fail(res, 404, "Payment not found");

    // Ownership check for customers
    if (req.user?.role === "Customer") {
      let ownerId = null;
      if (payment.itemType === "product") {
        const pb = await ProductBooking.findById(bookingId)
          .select("customerId")
          .lean();
        ownerId = pb?.customerId || pb?.userId || null;
      } else {
        const booking = await ServiceBooking.findById(bookingId)
          .select("customerId")
          .lean();
        ownerId = booking?.customerId || null;
      }
      if (!ownerId || String(ownerId) !== String(req.user.userId)) {
        return fail(res, 403, "Access denied");
      }
    } else if (!isPrivilegedRole(req.user?.role)) {
      return fail(res, 403, "Access denied");
    }

    return ok(res, 200, "Payment fetched", {
      paymentId: payment._id,
      status: payment.status,
      providerOrderId: payment.providerOrderId,
      providerPaymentId: payment.providerPaymentId,
      serviceAmount: payment.serviceAmount || payment.baseAmount || 0,
      gstPercentage: payment.gstPercentage || 0,
      gstAmount: payment.gstAmount || 0,
      tipAmount: payment.tipAmount || 0,
      totalAmount: payment.totalAmount,
      commissionAmount: payment.commissionAmount,
      technicianAmount: payment.technicianAmount,
      commissionRuleSource: payment.commissionRuleSource,
      failureReason: payment.failureReason,
      paidAt: payment.verifiedAt,
    });
  } catch (err) {
    return fail(res, err.statusCode || 500, err.message);
  }
};

/* =====================================================
   6️⃣ RETRY SETTLEMENT  (Admin/Owner, audited)
===================================================== */

export const retryPaymentSettlement = async (req, res) => {
  try {
    if (!requireAdminOrOwner(req, res)) return;

    const { bookingId } = req.body;
    if (!bookingId || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return fail(res, 400, "Valid bookingId is required", {});
    }

    const { settled, reason } = await settleBookingEarningsIfEligible(bookingId);

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "SETTLEMENT_MANUAL_RETRY",
      targetType: "ServiceBooking",
      targetId: bookingId,
      after: { settled, reason },
      reason: req.body.reason || null,
    });

    if (settled) {
      return ok(res, 200, "Settlement successful", { reason });
    }
    return fail(res, 400, "Settlement not applicable or failed", { reason });
  } catch (error) {
    return fail(res, 500, error.message, { error: error?.message });
  }
};
