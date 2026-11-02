/**
 * Quotation acceptance — the critical quote→order transaction (architecture §9).
 *
 * Inside ONE MongoDB transaction:
 *   1. atomically claim the quotation (sent/viewed + not expired) as accepted,
 *   2. create exactly one ProductBooking (unique bookingKey index is the
 *      idempotency backstop — a lost-response retry returns the same booking),
 *   3. advance the request to `accepted`,
 *   4. enqueue outbox delivery events.
 * Payment is then handled by the EXISTING payment pipeline using the new
 * booking's id (no quotation-specific payment code).
 */
import mongoose from "mongoose";
import Quotation from "../Schemas/Quotation.js";
import ProductQuoteRequest from "../Schemas/ProductQuoteRequest.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import { convertQuotationSnapshot } from "./quotationPricingService.js";
import { enqueueDeliveries } from "./quotationDeliveryService.js";
import { writeAuditLog } from "../Utils/audit.js";

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

const buildLocation = (address) => {
  if (address?.latitude != null && address?.longitude != null) {
    return { type: "Point", coordinates: [address.longitude, address.latitude] };
  }
  return undefined;
};

export const acceptQuotation = async ({ quotationId, customerId, acceptedItemIds }) => {
  if (!mongoose.Types.ObjectId.isValid(quotationId)) {
    const err = new Error("Invalid quotation id");
    err.statusCode = 400;
    throw err;
  }
  if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
    const err = new Error("Authenticated customer identity is required");
    err.statusCode = 401;
    err.code = "QUOTATION_AUTH_REQUIRED";
    throw err;
  }
  const ownerId = String(customerId);

  const forbidden = () => {
    const err = new Error("You do not own this quotation");
    err.statusCode = 403;
    err.code = "QUOTATION_FORBIDDEN";
    throw err;
  };

  // C2: ownership-enforcing pre-check. Never trust a client-supplied customer
  // id as proof of ownership — the caller's authenticated identity must match
  // the quotation's owning customer before any state is revealed or mutated.
  const existingQuote = await Quotation.findById(quotationId);
  if (!existingQuote) {
    throw new ConflictError("Quotation not found");
  }
  if (String(existingQuote.customerId) !== ownerId) forbidden();
  if (existingQuote.status === "superseded") {
    const err = new ConflictError("This quotation is no longer active. Please review the latest quotation.");
    err.code = "QUOTATION_SUPERSEDED";
    throw err;
  }
  if (existingQuote.status === "draft") {
    const err = new ConflictError("Draft quotations cannot be accepted.");
    err.code = "QUOTATION_DRAFT_NOT_ACCEPTED";
    throw err;
  }
  if (existingQuote.status === "accepted" || existingQuote.status === "converted") {
    const existingBookings = await ProductBooking.find({ quotationId });
    if (existingBookings.length > 0) {
      return { booking: existingBookings[0], bookings: existingBookings.slice(0, 1), paymentGroupId: null };
    }
  }
  if (existingQuote.status === "expired" || (existingQuote.validUntil && new Date(existingQuote.validUntil) < new Date())) {
    const err = new ConflictError("Quotation has expired");
    err.code = "QUOTATION_EXPIRED";
    throw err;
  }

  const session = await mongoose.startSession();
  let bookings = [];
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      // C2: atomic conditional claim — ownership + eligible status + not
      // expired in ONE findOneAndUpdate. Exactly one concurrent request can
      // win the sent/viewed → accepted transition; losers fall through to
      // the idempotent existing-bookings path below instead of double-booking.
      const quote = await Quotation.findOneAndUpdate(
        {
          _id: quotationId,
          customerId: ownerId,
          status: { $in: ["sent", "viewed"] },
          $or: [{ validUntil: { $gte: now } }, { validUntil: null }],
        },
        { $set: { status: "accepted", acceptedAt: now }, $inc: { version: 1 } },
        { new: true, session }
      );
      if (!quote) {
        const current = await Quotation.findOne({ _id: quotationId }).session(session);
        if (!current) throw new ConflictError("Quotation not found");
        if (String(current.customerId) !== ownerId) forbidden();
        if (current.status === "accepted" || current.status === "converted") {
          const already = await ProductBooking.find({ quotationId }).session(session);
          if (already.length > 0) {
            bookings = already;
            return;
          }
        }
        if (current.status === "expired" || (current.validUntil && new Date(current.validUntil) < now)) {
          if (current.status !== "expired") {
            await Quotation.updateOne(
              { _id: quotationId },
              { $set: { status: "expired" }, $inc: { version: 1 } },
              { session }
            );
          }
          const err = new ConflictError("Quotation has expired");
          err.code = "QUOTATION_EXPIRED";
          throw err;
        }
        throw new ConflictError("Quotation is unavailable or expired");
      }

      // New flow: every quote request represents exactly ONE product. Legacy
      // quotations may omit `items[]`; both shapes produce a single booking.
      // Multi-product quotations are rejected instead of silently creating
      // multiple orders that would need group payment.
      const hasItems = Array.isArray(quote.items) && quote.items.length > 0;
      if (hasItems && quote.items.length > 1) {
        const err = new ConflictError("Multi-product quotations are no longer supported. Ask the admin to send a single-product quotation.");
        err.code = "QUOTATION_SINGLE_PRODUCT_REQUIRED";
        throw err;
      }

      const item = hasItems ? quote.items[0] : null;
      if (item && Array.isArray(acceptedItemIds) && acceptedItemIds.length > 0) {
        const accepted = new Set(acceptedItemIds.map((id) => id.toString()));
        if (!accepted.has(item._id.toString())) {
          const err = new ConflictError("The quoted product must be accepted.");
          err.code = "QUOTATION_ITEM_NOT_ACCEPTED";
          throw err;
        }
      }
      if (item) item.status = "accepted";

      // Idempotent: a prior commit (lost response) already created the order.
      const existing = await ProductBooking.find({ quotationId }).session(session);
      if (existing.length > 0) {
        bookings = existing.slice(0, 1);
        return;
      }

      const address = quote.customerSnapshot?.address;
      const location = buildLocation(address);
      const locationType = location ? "gps" : "saved";

      const isPaidOnQuote = quote.paymentStatus === "paid";
      const itemSnap = item?.financialSnapshot || quote.financialSnapshot || {};
      const totalPaise = itemSnap.totalAmountPaise ?? quote.financialSnapshot?.totalAmountPaise ?? 0;
      const amountRupees = totalPaise > 0 ? totalPaise / 100 : (quote.amount || 0);
      const finalPaise = totalPaise > 0 ? totalPaise : Math.round(amountRupees * 100);

      const docs = [{
        quotationId: quote._id,
        bookingKey: String(quote._id),
        quoteRequestId: quote.quoteRequestId,
        productId: item?.productId || quote.productId,
        customerId: quote.customerId,
        quantity: item?.quantity || quote.quantity || 1,
        amount: amountRupees,
        amountPaise: finalPaise,
        financialSnapshot: convertQuotationSnapshot({ financialSnapshot: itemSnap }),
        addressSnapshot: address,
        location,
        locationType,
        paymentStatus: isPaidOnQuote ? "paid" : "pending",
        paidAmount: isPaidOnQuote ? amountRupees : 0,
        paidAmountPaise: isPaidOnQuote ? finalPaise : 0,
        status: "active",
      }];

      const created = await ProductBooking.create(docs, { session });
      bookings = created;

      // Persist the accepted item decision on the quotation.
      if (item) await quote.save({ session });

      await ProductQuoteRequest.updateOne(
        { _id: quote.quoteRequestId, status: { $in: ["quote_requested", "under_review", "quotation_prepared", "quotation_sent", "viewed"] } },
        { $set: { status: "accepted", acceptedQuotationId: quote._id }, $inc: { version: 1 } },
        { session }
      );

      await enqueueDeliveries({
        quotationId: quote._id,
        customerId: quote.customerId,
        requestId: quote.quoteRequestId,
        notificationType: "PRODUCT_QUOTATION_ACCEPTED",
        title: "Quotation accepted",
        body: `Your quotation ${quote.quotationNumber} was accepted. Proceed to payment to confirm your order.`,
        session,
      });
    });
  } finally {
    await session.endSession();
  }

  if (!bookings || bookings.length === 0) {
    const e = new ConflictError("Quotation is unavailable or expired");
    e.code = "QUOTATION_EXPIRED";
    throw e;
  }

  await writeAuditLog({
    actor: customerId,
    actorRole: "customer",
    action: "QUOTATION_ACCEPTED",
    targetType: "Quotation",
    targetId: quotationId,
    after: {
      bookingIds: bookings.map((b) => b._id),
      bookingKey: bookings[0]?.bookingKey,
      totalPaise: bookings.reduce((s, b) => s + (b.amountPaise || 0), 0),
    },
  });

  return { booking: bookings[0], bookings, paymentGroupId: null };
};

export const rejectQuotation = async ({ quotationId, customerId, reason }) => {
  if (!mongoose.Types.ObjectId.isValid(quotationId)) {
    const err = new Error("Invalid quotation id");
    err.statusCode = 400;
    err.code = "QUOTATION_INVALID_ID";
    throw err;
  }
  const session = await mongoose.startSession();
  let quotation = null;
  try {
    await session.withTransaction(async () => {
      const quote = await Quotation.findOneAndUpdate(
        { _id: quotationId, customerId, status: { $in: ["sent", "viewed"] } },
        { $set: { status: "rejected", rejectedAt: new Date(), rejectedReason: reason?.toString().slice(0, 500) || null }, $inc: { version: 1 } },
        { new: true, session }
      );
      if (!quote) {
        const err = new Error("Quotation cannot be rejected");
        err.statusCode = 409;
        err.code = "QUOTATION_REJECT_CONFLICT";
        throw err;
      }
      // Revert request status to under_review so request thread remains open for admin to send a revised quote (V2)
      await ProductQuoteRequest.updateOne(
        { _id: quote.quoteRequestId, status: { $in: ["quotation_sent", "viewed"] } },
        { $set: { status: "under_review" }, $inc: { version: 1 } },
        { session }
      );
      quotation = quote;
    });
  } finally {
    await session.endSession();
  }

  await writeAuditLog({
    actor: customerId,
    actorRole: "customer",
    action: "QUOTATION_REJECTED",
    targetType: "Quotation",
    targetId: quotationId,
    after: { reason: quotation?.rejectedReason },
  });
  return quotation;
};
