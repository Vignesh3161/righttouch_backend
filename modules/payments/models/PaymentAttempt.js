import mongoose from "mongoose";

const paymentAttemptSchema = new mongoose.Schema(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    method: { type: String, enum: ["razorpay", "cash", "wallet_credit"], default: "razorpay" },
    providerOrderId: { type: String, sparse: true, unique: true },
    providerPaymentId: { type: String, sparse: true, unique: true },
    amountPaise: { type: Number, required: true, min: 0 },
    state: {
      type: String,
      enum: ["created", "authorized", "captured", "failed", "expired", "abandoned"],
      default: "created",
    },
    idempotencyKey: { type: String, index: true },
    failureCode: String,
    failureReason: String,
    failureSource: String,
    expiresAt: { type: Date, required: true },
    closedAt: Date,
  },
  { timestamps: true }
);

// Hot paths used by the list/retry/sweeper flows
paymentAttemptSchema.index({ paymentId: 1, createdAt: -1 });
paymentAttemptSchema.index({ paymentId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
paymentAttemptSchema.index({ state: 1, expiresAt: 1 });

export default mongoose.models.PaymentAttempt || mongoose.model("PaymentAttempt", paymentAttemptSchema);
