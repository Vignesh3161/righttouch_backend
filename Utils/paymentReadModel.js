import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import Payment from "../Schemas/Payment.js";
import PaymentAttempt from "../Schemas/PaymentAttempt.js";
import { toPaise } from "./money.js";

const toObjectId = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null);

/** Find a booking owned by the customer across both collections. */
export const findBookingForCustomer = async (userId, bookingId) => {
  const id = toObjectId(bookingId);
  if (!id) return null;
  const svc = await ServiceBooking.findOne({ _id: id, customerId: userId }).lean();
  if (svc) return { ...svc, itemType: "service" };
  const prd = await ProductBooking.findOne({ _id: id, customerId: userId }).lean();
  if (prd) return { ...prd, itemType: "product" };
  return null;
};

/** Whether a booking is currently payable by the customer. */
export const isBookingPayable = (booking) => {
  if (booking.itemType === "service") return booking.status === "completed";
  return booking.status === "active" && booking.paymentStatus !== "paid";
};

const snapshotTotalPaise = (booking) => {
  if (booking.itemType === "service") {
    return booking?.financialSnapshot?.totalAmountPaise ?? booking?.totalAmountPaise ?? 0;
  }
  // P1/P2 — product total is the resolved-once snapshot (paise); fall back to
  // amount*100 only for legacy bookings created before the snapshot model.
  return booking?.financialSnapshot?.totalAmountPaise ?? toPaise(booking?.amount ?? 0);
};

/** Customer-facing derived state (separate from the engine Payment.status). */
export const deriveCustomerState = ({ booking, payment, liveAttempt, refunds = [] }) => {
  const total = payment?.totalAmountPaise || snapshotTotalPaise(booking) || 0;
  const refunded = payment?.amountRefundedPaise || 0;

  if (payment?.status === "success") {
    if (refunded > 0 && refunded < total) return "partially_refunded";
    if (refunded >= total) return "refunded";
    return "paid";
  }
  if (payment?.status === "manual_review") return "under_review";
  if (liveAttempt && ["created", "authorized"].includes(liveAttempt.state)) {
    return liveAttempt.method === "cash" ? "cash_due" : "processing";
  }
  if (payment?.status === "failed") return "failed";
  if (liveAttempt?.method === "cash") return "cash_due";
  if (isBookingPayable(booking)) return "due";
  return "not_due";
};

export const buildPaymentDetailsSummary = (payment) => {
  if (!payment || payment.status !== "success") return null;
  const mode = (payment.mode || "").toLowerCase();
  const provider = (payment.provider || "").toLowerCase();
  const ref = payment.providerPaymentId || payment.offlineDetails?.transactionReference || null;

  if (provider === "offline" || ["cash", "bank_transfer", "upi_direct", "cheque", "other"].includes(mode)) {
    const formattedMode =
      mode === "bank_transfer" ? "Bank Transfer" :
      mode === "upi_direct" ? "Direct UPI" :
      mode === "cheque" ? "Cheque" :
      mode === "cash" ? "Cash" : "Offline Payment";
    return ref ? `Paid via ${formattedMode} (Ref: ${ref})` : `Paid via ${formattedMode}`;
  }
  if (provider === "free") return "Free / Promotional";
  return ref ? `Paid Online via ${provider === "razorpay" ? "Razorpay" : provider} (ID: ${ref})` : "Paid Online";
};

/** PII-free, economics-free customer DTO (no commission / technician payout). */
export const buildCustomerPaymentDTO = ({ booking, payment, liveAttempt, state, refunds = [] }) => {
  const total = payment?.totalAmountPaise || snapshotTotalPaise(booking) || 0;
  const paid = payment?.status === "success" ? total : 0;
  const refunded = payment?.amountRefundedPaise || 0;
  const due = Math.max(0, total - paid);

  return {
    bookingId: booking._id?.toString(),
    paymentId: payment ? payment._id?.toString() : null,
    itemType: booking.itemType,
    customerState: state,
    amount: {
      basePaise: payment?.baseAmountPaise ?? null,
      gstPaise: payment?.gstAmountPaise ?? null,
      tipPaise: payment?.tipAmountPaise ?? null,
      discountPaise: 0,
      totalPaise: total,
      paidPaise: paid,
      duePaise: due,
      refundedPaise: refunded,
    },
    method: payment?.mode || liveAttempt?.method || payment?.provider || null,
    provider: payment?.provider || null,
    paymentMode: payment?.mode || (liveAttempt?.method || null),
    providerPaymentId: payment?.providerPaymentId || null,
    paymentDetailsSummary: buildPaymentDetailsSummary(payment),
    offlineDetails: payment?.offlineDetails || null,
    paidAt: payment?.verifiedAt || payment?.updatedAt || null,
    failure:
      payment?.status === "failed"
        ? { code: payment.failureReason || "FAILED", message: payment.failureReason || "Payment failed" }
        : null,
    liveAttempt: liveAttempt
      ? { attemptId: liveAttempt._id?.toString(), expiresAt: liveAttempt.expiresAt }
      : null,
    receiptAvailable: payment?.status === "success",
    bookingSummary: {
      title: booking.serviceName || booking.productName || (booking.itemType === "service" ? "Service" : "Product"),
      completedAt: booking.completedAt || null,
      zone: booking.cityZoneId || null,
      technicianFirstName: booking?.technicianSnapshot?.name || null,
    },
  };
};

/* ──────────────────────── List pagination ──────────────────────── */

const encodeCursor = ({ createdAt, _id }) =>
  Buffer.from(JSON.stringify({ c: new Date(createdAt).toISOString(), i: _id.toString() })).toString("base64");

const decodeCursor = (cursor) => {
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    return { createdAt: o.c, _id: o.i };
  } catch {
    return null;
  }
};

/** Booking-first page (obligation is the aggregate root), merged across both collections. */
export const fetchBookingsPage = async ({ userId, cursor, limit }) => {
  const filter = { customerId: userId };
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded) {
    const createdAt = new Date(decoded.createdAt);
    const _id = toObjectId(decoded._id);
    filter.$or = [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: _id } },
    ];
  }

  const [svc, prd] = await Promise.all([
    ServiceBooking.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean(),
    ProductBooking.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean(),
  ]);

  let merged = [
    ...svc.map((b) => ({ ...b, itemType: "service" })),
    ...prd.map((b) => ({ ...b, itemType: "product" })),
  ];
  merged.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (tb !== ta) return tb - ta;
    return a._id > b._id ? -1 : 1;
  });
  merged = merged.slice(0, limit);
  return { bookings: merged, nextCursor: merged.length ? encodeCursor(merged[merged.length - 1]) : null };
};

export const getLiveAttempt = async (paymentId) => {
  if (!paymentId) return null;
  return PaymentAttempt.findOne({
    paymentId,
    state: { $in: ["created", "authorized"] },
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();
};

/** Expected credit date for a refund (gateway SLA: 5–7 working days). */
export const expectedCreditDate = (createdAt) => {
  const d = new Date(createdAt || Date.now());
  d.setDate(d.getDate() + 7);
  return d;
};
