/**
 * Quotation acceptance — the critical quote→order transaction (architecture §9).
 *
 * Inside ONE MongoDB transaction:
 *   1. atomically claim the quotation (sent/viewed + not expired) as accepted,
 *   2. create the ProductBooking exactly once (unique quotationId index is the
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

  // Idempotent & validation check: Ensure quotation exists and is in an acceptable state
  const existingQuote = await Quotation.findById(quotationId);
  if (!existingQuote) {
    throw new ConflictError("Quotation not found");
  }
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
      return { bookings: existingBookings, paymentGroupId: existingBookings[0]?.paymentGroupId };
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
      const quote = await Quotation.findOne({
        _id: quotationId,
        status: { $in: ["sent", "viewed", "accepted"] },
      }).session(session);
      if (!quote) throw new ConflictError("Quotation is unavailable or expired");

      if (quote.status !== "accepted") {
        if (quote.validUntil && new Date(quote.validUntil) < now) {
          quote.status = "expired";
          await quote.save({ session });
          const err = new ConflictError("Quotation has expired");
          err.code = "QUOTATION_EXPIRED";
          throw err;
        }
        quote.status = "accepted";
        quote.acceptedAt = now;
        quote.version = (quote.version || 0) + 1;
        await quote.save({ session });
      }

      // Multi-product: decide which items are accepted.
      // Legacy (no items[]) => the whole quotation is one product.
      const isMulti = Array.isArray(quote.items) && quote.items.length > 0;
      const acceptedItemIdSet = Array.isArray(acceptedItemIds)
        ? new Set(acceptedItemIds.map((id) => id.toString()))
        : null;

      const itemsToBook = isMulti
        ? quote.items.filter((it) => {
            const keep =
              acceptedItemIdSet === null || acceptedItemIdSet.has(it._id.toString());
            // Mark the rejected items on the quotation for audit.
            if (!keep) it.status = "rejected";
            else it.status = "accepted";
            return keep;
          })
        : [{ productId: quote.productId, quantity: quote.quantity, financialSnapshot: quote.financialSnapshot, _id: null }];

      // Idempotent: a prior commit (lost response) already created the orders.
      const existing = await ProductBooking.find({ quotationId }).session(session);
      if (existing.length > 0) {
        bookings = existing;
        return;
      }

      const paymentGroupId = new mongoose.Types.ObjectId();
      const address = quote.customerSnapshot?.address;
      const location = buildLocation(address);
      const locationType = location ? "gps" : "saved";

      const isPaidOnQuote = quote.paymentStatus === "paid";
      const docs = itemsToBook.map((item) => {
        const itemSnap = item.financialSnapshot || quote.financialSnapshot || {};
        const totalPaise = itemSnap.totalAmountPaise ?? quote.financialSnapshot?.totalAmountPaise ?? 0;
        const amountRupees = totalPaise > 0 ? totalPaise / 100 : (quote.amount || 0);
        const finalPaise = totalPaise > 0 ? totalPaise : Math.round(amountRupees * 100);

        return {
          quotationId: quote._id,
          quoteRequestId: quote.quoteRequestId,
          paymentGroupId,
          productId: item.productId,
          customerId: quote.customerId,
          quantity: item.quantity || 1,
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
        };
      });

      const created = await ProductBooking.create(docs, { session });
      bookings = created;

      // Persist per-item accept/reject decisions on the quotation.
      if (isMulti) await quote.save({ session });

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
        body:
          `Your quotation ${quote.quotationNumber} was accepted` +
          (docs.length > 1 ? ` (${docs.length} products).` : ".") +
          " Proceed to payment to confirm your order.",
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
      paymentGroupId: bookings[0]?.paymentGroupId,
      totalPaise: bookings.reduce((s, b) => s + (b.amountPaise || 0), 0),
    },
  });

  return { bookings, paymentGroupId: bookings[0]?.paymentGroupId };
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
