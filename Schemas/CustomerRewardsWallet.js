import mongoose from "mongoose";

/**
 * 🪙 CUSTOMER REWARDS WALLET — promotional coins, NOT cash.
 *
 * One wallet per customer (unique index). Coins are earned from eligible
 * service bookings and will be redeemable for discounts (Phase 4). They
 * can never be withdrawn, transferred to technicians, or enter technician
 * earnings/payout math. Integer coins only; `availableCoins`/`reservedCoins`
 * are guarded non-negative at the schema level AND by conditional updates.
 */
const customerRewardsWalletSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    availableCoins: { type: Number, default: 0, min: 0 },
    reservedCoins: { type: Number, default: 0, min: 0 },
    lifetimeEarnedCoins: { type: Number, default: 0, min: 0 },
    lifetimeRedeemedCoins: { type: Number, default: 0, min: 0 },
    lifetimeExpiredCoins: { type: Number, default: 0, min: 0 },
    lifetimeReversedCoins: { type: Number, default: 0, min: 0 },
    walletVersion: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

export default mongoose.models.CustomerRewardsWallet ||
  mongoose.model("CustomerRewardsWallet", customerRewardsWalletSchema);
