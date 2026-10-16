import mongoose from "mongoose";

/**
 * 🧾 REWARD REDEMPTION — checkout reservation lifecycle (Phase 4).
 *
 * Declared now so the lifecycle states are locked before any behavior is
 * built. No routes or service logic touch this collection until redemption
 * is accounting-approved:
 *   reserved → consumed (payment success) | released (failure/expiry)
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
    idempotencyKey: { type: String, default: null, unique: true, sparse: true },
    note: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

rewardRedemptionSchema.index({ customerId: 1, status: 1 });

export default mongoose.models.RewardRedemption ||
  mongoose.model("RewardRedemption", rewardRedemptionSchema);
