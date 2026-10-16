import mongoose from "mongoose";

/**
 * 🏷 REWARD POLICY — versioned, admin-governed customer rewards rules.
 *
 * Only ONE version is active at a time (partial unique index). Awards stamp
 * `policyVersion` + calculation inputs so later policy changes never rewrite
 * history. Integer-only math: rate stored as basis points (150 = 1.5%).
 *
 * Conversion is fixed: 100 coins = ₹1, i.e. 1 coin == 1 paise of reward
 * value. Earning basis is the authoritative service subtotal
 * (`financialSnapshot.baseAmountPaise`) — tips, GST and discounts excluded.
 */
const rewardPolicySchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true, min: 1 },
    isActive: { type: Boolean, default: false, index: true },
    // Master switch for earning (redemption has its own flag, Phase 4).
    earningEnabled: { type: Boolean, default: true },
    redemptionEnabled: { type: Boolean, default: false },
    // 100 = 1%. Integer-only: floor(eligiblePaise * rateBps / 10000).
    rewardRateBps: { type: Number, required: true, min: 0, max: 10000 },
    // Fixed conversion; stored for audit transparency.
    coinsPerRupee: { type: Number, default: 100, min: 1 },
    // Proposed defaults — require business/finance sign-off (see runbook).
    maxRedemptionPct: { type: Number, default: 20, min: 0, max: 100 },
    minEligiblePaise: { type: Number, default: 0, min: 0 },
    maxCoinsPerBooking: { type: Number, default: null, min: 1 },
    expiryMonths: { type: Number, default: 12, min: 1, max: 60 },
    notes: { type: String, trim: true, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdByRole: { type: String, enum: ["Admin", "Owner", "System"], default: null },
  },
  { timestamps: true }
);

// Exactly one active policy version.
rewardPolicySchema.index(
  { isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: "uniq_active_reward_policy" }
);

export default mongoose.models.RewardPolicy ||
  mongoose.model("RewardPolicy", rewardPolicySchema);
