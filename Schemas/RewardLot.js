import mongoose from "mongoose";

/**
 * 🎟 REWARD LOT — per-award coin batch with its own expiry.
 *
 * A single aggregate balance cannot expire different earning batches
 * correctly, so each EARN mints a lot. Expiry consumes oldest lots first
 * (FIFO). Refund reversals target the originating lot. Redemption also
 * consumes lots FIFO and holds the allocation while payment is pending.
 */
const rewardLotSchema = new mongoose.Schema(
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
      required: true,
      index: true,
    },
    earnTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RewardTransaction",
      default: null,
    },
    coinsTotal: { type: Number, required: true, min: 1 },
    coinsRemaining: { type: Number, required: true, min: 0 },
    earnedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    policyVersion: { type: Number, default: null },
  },
  { timestamps: true }
);

rewardLotSchema.index({ customerId: 1, expiresAt: 1 });
rewardLotSchema.index({ customerId: 1, coinsRemaining: 1, expiresAt: 1 });

export default mongoose.models.RewardLot ||
  mongoose.model("RewardLot", rewardLotSchema);
