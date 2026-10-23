import mongoose from "mongoose";

/**
 * 📒 REWARD TRANSACTION — append-only rewards ledger.
 *
 * Immutable: correct errors with compensating entries (REVERSAL/EXPIRE),
 * never edits or deletes. Mirrors WalletTransaction conventions
 * (integer units, sparse-unique idempotencyKey, balance-after audit).
 * `coins` is always non-negative; direction comes from `type`.
 */
const rewardTransactionSchema = new mongoose.Schema(
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
    redemptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RewardRedemption",
      default: null,
      index: true,
    },
    // Integer coins (1 coin == 1 paise of reward value).
    coins: { type: Number, required: true, min: 0 },
    // Rupee mirror for display/audit (coins / 100), informational only.
    rupees: { type: Number, default: null },
    type: {
      type: String,
      enum: ["EARN", "REDEEM", "RELEASE", "RESTORE", "EXPIRE", "REVERSAL"],
      required: true,
      index: true,
    },
    // availableCoins after this entry posted (audit trail).
    balanceAfterCoins: { type: Number, default: null, min: 0 },
    policyVersion: { type: Number, default: null },
    // Calculation inputs snapshot (eligible paise, rate bps) for EARN.
    calcInputs: {
      eligiblePaise: { type: Number, default: null },
      rateBps: { type: Number, default: null },
    },
    // Global idempotency key — "service-reward:<bookingId>",
    // "reward-reversal:<refundId>", "reward-expire:<lotId>", ...
    idempotencyKey: { type: String, default: null, unique: true, sparse: true },
    status: {
      type: String,
      enum: ["posted"],
      default: "posted",
    },
    note: { type: String, trim: true, default: null },
    reason: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

// One earn per booking (prevents double-award).
rewardTransactionSchema.index(
  { bookingId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      bookingId: { $exists: true, $ne: null },
      type: "EARN",
    },
    name: "uniq_earn_per_booking",
  }
);

rewardTransactionSchema.index({ customerId: 1, createdAt: -1 });
rewardTransactionSchema.index({ customerId: 1, type: 1 });

export default mongoose.models.RewardTransaction ||
  mongoose.model("RewardTransaction", rewardTransactionSchema);
