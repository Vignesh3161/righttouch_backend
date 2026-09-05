import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Channel delivery tracker + outbox for quotations.
 *
 * The application DB is the source of truth; WhatsApp / push / SMS / email are
 * delivery channels only. Each row is an outbox event: it is created (pending)
 * inside the same transaction that changes the quotation, then a worker sends
 * it and records provider status. A failed delivery updates THIS document but
 * must NEVER flip the parent Quotation back to a failed state.
 */
const QuotationDeliverySchema = new Schema(
  {
    quotationId: { type: Schema.Types.ObjectId, ref: "Quotation", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    requestId: { type: Schema.Types.ObjectId, ref: "ProductQuoteRequest" },

    channel: {
      type: String,
      enum: ["in_app", "whatsapp", "sms", "email"],
      required: true,
    },
    // What kind of message this delivery represents (e.g. QUOTATION_SENT).
    notificationType: { type: String, required: true },

    status: {
      type: String,
      enum: ["pending", "queued", "sent", "delivered", "read", "failed"],
      default: "pending",
      index: true,
    },
    providerMessageId: String,
    attempts: { type: Number, default: 0 },
    lastError: String,
    sentAt: Date,
    deliveredAt: Date,
    readAt: Date,
    nextAttemptAt: { type: Date, default: Date.now },

    // Denormalized preview for quick display / debugging.
    title: String,
    body: String,
  },
  { timestamps: true }
);

// Idempotent enqueue: exactly one delivery row per (quotation, channel, type).
// Resend/retry updates the same row instead of creating duplicates.
QuotationDeliverySchema.index(
  { quotationId: 1, channel: 1, notificationType: 1 },
  { unique: true }
);

export default mongoose.models.QuotationDelivery ||
  mongoose.model("QuotationDelivery", QuotationDeliverySchema);
