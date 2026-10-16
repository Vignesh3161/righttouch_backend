import mongoose from "mongoose";

import RewardPolicy from "../Schemas/RewardPolicy.js";
import CustomerRewardsWallet from "../Schemas/CustomerRewardsWallet.js";
import RewardTransaction from "../Schemas/RewardTransaction.js";
import {
  getRewardBalance,
  getRewardHistory,
  reconcileRewardWallet,
  listRewardTransactionsForAdmin,
  listRewardWalletsForAdmin,
  getCustomerRewardOverview,
} from "../Services/rewardService.js";
import { writeAuditLog } from "../Utils/audit.js";
import { ensureCustomer } from "../Utils/ensureCustomer.js";

/* ---------------- Customer ---------------- */

export const getMyRewardBalance = async (req, res) => {
  try {
    ensureCustomer(req);
    const balance = await getRewardBalance(req.user.userId);
    return res.json({ success: true, result: balance });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const getMyRewardHistory = async (req, res) => {
  try {
    ensureCustomer(req);
    const history = await getRewardHistory(req.user.userId, {
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ success: true, result: history });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const reconcileMyRewards = async (req, res) => {
  try {
    ensureCustomer(req);
    const report = await reconcileRewardWallet(req.user.userId);
    return res.json({ success: true, result: report });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/* ---------------- Admin / Owner ---------------- */

export const getRewardPolicy = async (req, res) => {
  try {
    const [active, history] = await Promise.all([
      RewardPolicy.findOne({ isActive: true }).lean(),
      RewardPolicy.find({}).select("version isActive earningEnabled redemptionEnabled rewardRateBps expiryMonths createdAt").sort({ version: -1 }).limit(20).lean(),
    ]);
    return res.json({ success: true, result: { active, history } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const toInt = (v, fallback = null) => {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};

export const createRewardPolicy = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const rateBps = toInt(req.body?.rewardRateBps, null);
    if (rateBps == null || rateBps < 0 || rateBps > 10000) {
      return res.status(400).json({ success: false, message: "rewardRateBps must be an integer 0..10000 (basis points)" });
    }
    const expiryMonths = toInt(req.body?.expiryMonths, 12);
    if (expiryMonths < 1 || expiryMonths > 60) {
      return res.status(400).json({ success: false, message: "expiryMonths must be 1..60" });
    }
    const maxRedemptionPct = toInt(req.body?.maxRedemptionPct, 20);
    if (maxRedemptionPct < 0 || maxRedemptionPct > 100) {
      return res.status(400).json({ success: false, message: "maxRedemptionPct must be 0..100" });
    }
    const result = await session.withTransaction(async () => {
      const maxV = await RewardPolicy.findOne({}).select("version").sort({ version: -1 }).session(session).lean();
      await RewardPolicy.updateMany({ isActive: true }, { $set: { isActive: false } }, { session });
      const [created] = await RewardPolicy.create(
        [
          {
            version: (maxV?.version || 0) + 1,
            isActive: true,
            earningEnabled: req.body?.earningEnabled !== false,
            redemptionEnabled: false, // redemption stays disabled until accounting approval
            rewardRateBps: rateBps,
            coinsPerRupee: 100,
            maxRedemptionPct,
            minEligiblePaise: Math.max(0, toInt(req.body?.minEligiblePaise, 0)),
            maxCoinsPerBooking: req.body?.maxCoinsPerBooking != null ? Math.max(1, toInt(req.body.maxCoinsPerBooking)) : null,
            expiryMonths,
            notes: req.body?.notes || null,
            createdBy: req.user?.userId || null,
            createdByRole: req.user?.role || null,
          },
        ],
        { session }
      );
      return created;
    });
    await writeAuditLog({
      actor: req.user?.userId,
      actorRole: req.user?.role,
      action: "REWARD_POLICY_CREATED",
      targetType: "RewardPolicy",
      targetId: result._id,
      after: { version: result.version, rewardRateBps: result.rewardRateBps },
    }).catch(() => {});
    return res.status(201).json({ success: true, result });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: "Policy version conflict — retry" });
    }
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.endSession();
  }
};

export const getRewardMetrics = async (req, res) => {
  try {
    const [byType, wallets, activePolicy] = await Promise.all([
      RewardTransaction.aggregate([
        { $group: { _id: "$type", coins: { $sum: "$coins" }, count: { $sum: 1 } } },
      ]),
      CustomerRewardsWallet.aggregate([
        {
          $group: {
            _id: null,
            wallets: { $sum: 1 },
            available: { $sum: "$availableCoins" },
            reserved: { $sum: "$reservedCoins" },
            earned: { $sum: "$lifetimeEarnedCoins" },
          },
        },
      ]),
      RewardPolicy.findOne({ isActive: true }).select("version earningEnabled redemptionEnabled coinsPerRupee").lean(),
    ]);
    return res.json({
      success: true,
      result: {
        byType: Object.fromEntries(byType.map((r) => [r._id, { coins: r.coins, count: r.count }])),
        wallets: wallets[0] || { wallets: 0, available: 0, reserved: 0, earned: 0 },
        outstandingRupees: ((wallets[0]?.available || 0) + (wallets[0]?.reserved || 0)) / 100,
        // Phase 1 capability flags (additive only): lets the Admin UI
        // distinguish live earning from unavailable redemption without
        // guessing from absent REDEEM rows.
        capabilities: {
          earningEnabled: activePolicy?.earningEnabled ?? false,
          redemptionEnabled: false,
          redemptionStatus: "disabled_until_accounting_approval",
          coinsPerRupee: activePolicy?.coinsPerRupee ?? 100,
          activePolicyVersion: activePolicy?.version ?? null,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ---------- Phase 1: Admin read-only support views (no mutation) --- */

export const adminListRewardTransactions = async (req, res) => {
  try {
    const result = await listRewardTransactionsForAdmin({
      customerId: req.query.customerId,
      bookingId: req.query.bookingId,
      type: req.query.type,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const adminListRewardWallets = async (req, res) => {
  try {
    const result = await listRewardWalletsForAdmin({
      page: req.query.page,
      limit: req.query.limit,
      sort: req.query.sort,
      minAvailableCoins: req.query.minAvailableCoins,
    });
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const adminGetCustomerRewardOverview = async (req, res) => {
  try {
    const result = await getCustomerRewardOverview(req.params.customerId);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};
