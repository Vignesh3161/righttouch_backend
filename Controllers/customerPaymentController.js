import mongoose from "mongoose";
import Payment from "../Schemas/Payment.js";
import PaymentAttempt from "../Schemas/PaymentAttempt.js";
import Refund from "../Schemas/Refund.js";
import { createPaymentOrder } from "../Controllers/paymentController.js";
import { findBookingForCustomer, isBookingPayable, deriveCustomerState, buildCustomerPaymentDTO, fetchBookingsPage, getLiveAttempt, expectedCreditDate } from "../Utils/paymentReadModel.js";
import { createAttempt, hasLiveAttempt } from "../Utils/paymentAttempts.js";
import { ensureReceipt, buildInvoiceHtml } from "../Utils/receiptService.js";
import { toPaise } from "../Utils/money.js";

const ok = (res, status, message, result = {}) => res.status(status).json({ success: true, message, result });
const fail = (res, status, message, result = {}) => res.status(status).json({ success: false, message, result });

const requireCustomer = (req, res) => {
  if (req.user?.role !== "Customer") {
    fail(res, 403, "Customer access only");
    return false;
  }
  return true;
};

// Mirror the engine's money source for a (possibly pre-payment) booking.
const snapshotTotalPaise = (booking) =>
  booking.itemType === "service"
    ? booking?.financialSnapshot?.totalAmountPaise ?? booking?.totalAmountPaise ?? 0
    : toPaise(booking?.amount ?? 0);

/* 3.1 List (booking-first) */
export const listMyPayments = async (req, res) => {
  if (!requireCustomer(req, res)) return;
  try {
    const { state, cursor, limit = 20 } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 20, 50);
    const { bookings, nextCursor } = await fetchBookingsPage({ userId: req.user.userId, cursor, limit: lim });

    const bookingIds = bookings.map((b) => b._id);
    const payments = bookingIds.length ? await Payment.find({ bookingId: { $in: bookingIds } }).lean() : [];
    const paymentByBooking = new Map(payments.map((p) => [p.bookingId.toString(), p]));
    const paymentIds = payments.map((p) => p._id);

    const liveAttempts = paymentIds.length
      ? await PaymentAttempt.find({
          paymentId: { $in: paymentIds },
          state: { $in: ["created", "authorized"] },
          expiresAt: { $gt: new Date() },
        }).lean()
      : [];
    const liveByPayment = new Map();
    for (const a of liveAttempts) {
      const k = a.paymentId.toString();
      if (!liveByPayment.has(k)) liveByPayment.set(k, a);
    }

    let items = bookings.map((b) => {
      const p = paymentByBooking.get(b._id.toString());
      const la = p ? liveByPayment.get(p._id.toString()) : null;
      const st = deriveCustomerState({ booking: b, payment: p, liveAttempt: la });
      return buildCustomerPaymentDTO({ booking: b, payment: p, liveAttempt: la, state: st });
    });

    if (state) items = items.filter((i) => i.customerState === state);

    const due = items.filter((i) => i.customerState === "due" || i.customerState === "cash_due");
    const dueTotalPaise = due.reduce((s, i) => s + (i.amount.duePaise || 0), 0);

    return ok(res, 200, "Payments", {
      items,
      summary: { dueCountInView: due.length, dueTotalPaise },
      nextCursor,
      hasMore: bookings.length >= lim,
    });
  } catch (err) {
    console.error("listMyPayments Error:", err);
    return fail(res, 500, "Server error", { error: err.message });
  }
};

/* 3.2 Detail */
export const getMyPaymentDetail = async (req, res) => {
  if (!requireCustomer(req, res)) return;
  try {
    const booking = await findBookingForCustomer(req.user.userId, req.params.bookingId);
    if (!booking) return fail(res, 404, "Booking not found");

    const payment = await Payment.findOne({ bookingId: booking._id }).lean();
    const liveAttempt = payment ? await getLiveAttempt(payment._id) : null;
    const state = deriveCustomerState({ booking, payment, liveAttempt });

    const attempts = payment
      ? await PaymentAttempt.find({ paymentId: payment._id }).sort({ createdAt: -1 }).limit(10).lean()
      : [];
    const refunds = payment
      ? await Refund.find({ paymentId: payment._id }).sort({ createdAt: -1 }).lean()
      : [];

    const dto = buildCustomerPaymentDTO({ booking, payment, liveAttempt, state });
    return ok(res, 200, "Payment detail", {
      ...dto,
      attempts: attempts.map((a) => ({
        attemptId: a._id?.toString(),
        method: a.method,
        state: a.state,
        failureReason: a.failureReason,
        createdAt: a.createdAt,
      })),
      refunds: refunds.map((r) => ({
        reason: r.reason,
        grossPaise: r.grossPaise,
        cancellationFeePaise: r.cancellationFeePaise,
        netRefundPaise: r.netRefundPaise,
        status: r.status,
        createdAt: r.createdAt,
        expectedCreditBy: expectedCreditDate(r.createdAt),
      })),
    });
  } catch (err) {
    console.error("getMyPaymentDetail Error:", err);
    return fail(res, 500, "Server error", { error: err.message });
  }
};

/* 3.3 Summary */
export const getMyPaymentSummary = async (req, res) => {
  if (!requireCustomer(req, res)) return;
  try {
    const [svc, prd] = await Promise.all([
      mongoose.model("ServiceBooking").find({ customerId: req.user.userId }).distinct("_id"),
      mongoose.model("ProductBooking").find({ customerId: req.user.userId }).distinct("_id"),
    ]);
    const bookingIds = [...svc, ...prd];
    const payments = bookingIds.length ? await Payment.find({ bookingId: { $in: bookingIds } }).lean() : [];

    let amountDuePaise = 0,
      lifetimeSpentPaise = 0,
      dueCount = 0,
      processingCount = 0,
      failedCount = 0,
      refundedPaise = 0,
      thisMonthPaise = 0;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    for (const p of payments) {
      const total = p.totalAmountPaise || 0;
      if (p.status === "success") {
        lifetimeSpentPaise += total;
        if (p.verifiedAt && new Date(p.verifiedAt) >= monthStart) thisMonthPaise += total;
      }
      if (p.status === "pending") {
        amountDuePaise += total;
        dueCount += 1;
      }
      if (p.status === "manual_review") processingCount += 1;
      if (p.status === "failed") failedCount += 1;
      refundedPaise += p.amountRefundedPaise || 0;
    }

    return ok(res, 200, "Summary", {
      amountDuePaise,
      dueCount,
      lifetimeSpentPaise,
      thisMonthPaise,
      processingCount,
      failedCount,
      refundedPaise,
    });
  } catch (err) {
    console.error("getMyPaymentSummary Error:", err);
    return fail(res, 500, "Server error", { error: err.message });
  }
};

/* 3.4 Initiate (wraps existing createPaymentOrder, then records an attempt) */
export const initiatePayment = async (req, res) => {
  if (!requireCustomer(req, res)) return;
  try {
    const booking = await findBookingForCustomer(req.user.userId, req.params.bookingId);
    if (!booking) return fail(res, 404, "Booking not found");
    if (!isBookingPayable(booking)) return fail(res, 400, "NOT_PAYABLE", { code: "NOT_PAYABLE" });

    req.body = { ...req.body, bookingId: req.params.bookingId };
    await createPaymentOrder(req, res); // sends its own response (order + split)

    // Response already sent by createPaymentOrder — record attempt for audit/in-flight tracking.
    try {
      const payment = await Payment.findOne({ bookingId: booking._id }).lean();
      const idem = req.get("Idempotency-Key") || req.body.idempotencyKey;
      if (payment && idem) {
        await createAttempt({
          paymentId: payment._id,
          bookingId: booking._id,
          customerId: req.user.userId,
          amountPaise: payment.totalAmountPaise,
          method: "razorpay",
          idempotencyKey: idem,
          providerOrderId: payment.providerOrderId,
        });
      }
    } catch (e) {
      console.error("initiatePayment attempt-record error:", e.message);
    }
  } catch (err) {
    if (!res.headersSent) return fail(res, err.statusCode || 500, err.message);
  }
};

/* 3.5 Retry (safe: gates before re-ordering) */
export const retryMyPayment = async (req, res) => {
  if (!requireCustomer(req, res)) return;
  try {
    const booking = await findBookingForCustomer(req.user.userId, req.params.bookingId);
    if (!booking) return fail(res, 404, "Booking not found");

    const payment = await Payment.findOne({ bookingId: booking._id }).lean();
    if (payment?.status === "success") return fail(res, 409, "ALREADY_PAID", { code: "ALREADY_PAID" });
    if (payment?.status === "manual_review") return fail(res, 409, "UNDER_REVIEW", { code: "UNDER_REVIEW" });
    if (payment && (await hasLiveAttempt(payment._id)))
      return fail(res, 409, "PAYMENT_IN_FLIGHT", { code: "PAYMENT_IN_FLIGHT" });
    if (!isBookingPayable(booking)) return fail(res, 400, "NOT_PAYABLE", { code: "NOT_PAYABLE" });

    req.body = { ...req.body, bookingId: req.params.bookingId };
    await createPaymentOrder(req, res); // existing engine re-orders (resync) and responds

    try {
      const p2 = await Payment.findOne({ bookingId: booking._id }).lean();
      const idem = req.get("Idempotency-Key") || req.body.idempotencyKey;
      if (p2 && idem) {
        await createAttempt({
          paymentId: p2._id,
          bookingId: booking._id,
          customerId: req.user.userId,
          amountPaise: p2.totalAmountPaise,
          method: "razorpay",
          idempotencyKey: idem,
          providerOrderId: p2.providerOrderId,
        });
      }
    } catch (e) {
      console.error("retryMyPayment attempt-record error:", e.message);
    }
  } catch (err) {
    if (!res.headersSent) return fail(res, err.statusCode || 500, err.message);
  }
};

/* 3.6 Receipt */
export const getReceipt = async (req, res) => {
  if (!requireCustomer(req, res)) return;
  try {
    const booking = await findBookingForCustomer(req.user.userId, req.params.bookingId);
    if (!booking) return fail(res, 404, "Booking not found");
    const payment = await Payment.findOne({ bookingId: booking._id }).lean();
    if (!payment || payment.status !== "success") return fail(res, 404, "Receipt not available yet");
    const receipt = await ensureReceipt(payment._id);
    if (!receipt) return fail(res, 404, "Receipt not generated");
    return ok(res, 200, "Receipt", {
      receiptNumber: receipt.receiptNumber,
      invoiceHtml: buildInvoiceHtml(receipt),
      invoiceUrl: receipt.invoiceUrl,
      issuedAt: receipt.issuedAt,
    });
  } catch (err) {
    console.error("getReceipt Error:", err);
    return fail(res, 500, "Server error", { error: err.message });
  }
};

/* 3.8 Refunds (read) */
export const getRefunds = async (req, res) => {
  if (!requireCustomer(req, res)) return;
  try {
    const booking = await findBookingForCustomer(req.user.userId, req.params.bookingId);
    if (!booking) return fail(res, 404, "Booking not found");
    const payment = await Payment.findOne({ bookingId: booking._id }).lean();
    const refunds = payment ? await Refund.find({ paymentId: payment._id }).sort({ createdAt: -1 }).lean() : [];
    return ok(res, 200, "Refunds", {
      refunds: refunds.map((r) => ({
        reason: r.reason,
        grossPaise: r.grossPaise,
        cancellationFeePaise: r.cancellationFeePaise,
        netRefundPaise: r.netRefundPaise,
        status: r.status,
        createdAt: r.createdAt,
        expectedCreditBy: expectedCreditDate(r.createdAt),
      })),
    });
  } catch (err) {
    console.error("getRefunds Error:", err);
    return fail(res, 500, "Server error", { error: err.message });
  }
};

/* 3.7 Cash declare (phase 2, minimal — awaits technician confirmation) */
export const declareCashPayment = async (req, res) => {
  if (!requireCustomer(req, res)) return;
  try {
    const booking = await findBookingForCustomer(req.user.userId, req.params.bookingId);
    if (!booking) return fail(res, 404, "Booking not found");
    const payment = await Payment.findOne({ bookingId: booking._id });
    if (payment?.status === "success") return fail(res, 409, "ALREADY_PAID", { code: "ALREADY_PAID" });
    if (payment && (await hasLiveAttempt(payment._id)))
      return fail(res, 409, "PAYMENT_IN_FLIGHT", { code: "PAYMENT_IN_FLIGHT" });

    const idem = req.body?.idempotencyKey || `cash_${booking._id}_${Date.now()}`;
    const attempt = await createAttempt({
      paymentId: payment?._id || undefined,
      bookingId: booking._id,
      customerId: req.user.userId,
      amountPaise: snapshotTotalPaise(booking),
      method: "cash",
      idempotencyKey: idem,
      state: "authorized",
    });
    return ok(res, 202, "Cash payment declared, awaiting technician confirmation", {
      attemptId: attempt._id?.toString(),
    });
  } catch (err) {
    console.error("declareCashPayment Error:", err);
    return fail(res, 500, "Server error", { error: err.message });
  }
};
