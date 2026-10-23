import mongoose from "mongoose";

/**
 * 🧾 REWARD REDEMPTION — payment-time checkout reservation lifecycle.
 *
 * State machine:
 *   reserved → consumed (payment success) | released (failure/expiry)
 * `expired` remains available for legacy/external status compatibility;
 * the expiry job records `released` with reason `reservation_expired`.
 */
const rewardRedemptionSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      default: null,
      index: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
      index: true,
    },
    coinsReserved: { type: Number, required: true, min: 1 },
    discountPaise: { type: Number, required: true, min: 1 },
    policyVersion: { type: Number, default: null },
    status: {
      type: String,
      enum: ["reserved", "consumed", "released", "expired"],
      default: "reserved",
      index: true,
    },
    expiresAt: { type: Date, default: null, index: true },
    consumedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    // FIFO lot reservations held while the payment is pending. Lots are
    // decremented at reserve time so expiry cannot steal reserved coins.
    lotAllocations: [
      {
        _id: false,
        lotId: { type: mongoose.Schema.Types.ObjectId, ref: "RewardLot", required: true },
        coins: { type: Number, required: true, min: 1 },
      },
    ],
    reservationAttempts: { type: Number, default: 0, min: 0 },
    releasedReason: { type: String, trim: true, default: null },
    consumedTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RewardTransaction",
      default: null,
    },
    idempotencyKey: { type: String, default: null, unique: true, sparse: true },
    note: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

rewardRedemptionSchema.index({ customerId: 1, status: 1 });
rewardRedemptionSchema.index({ status: 1, expiresAt: 1 });
rewardRedemptionSchema.index(
  { paymentId: 1 },
  { unique: true, partialFilterExpression: { paymentId: { $type: "objectId" } }, name: "uniq_redemption_per_payment" }
);

export default mongoose.models.RewardRedemption ||
  mongoose.model("RewardRedemption", rewardRedemptionSchema);
