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
  getRewardRedemptionQuote,
  getRewardRedemptions,
  listRewardRedemptionsForAdmin,
  getRewardLiabilitySummary,
} from "../Services/rewardService.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import Payment from "../Schemas/Payment.js";
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

export const getMyRedemptionPreview = async (req, res) => {
  try {
    ensureCustomer(req);
    if (!mongoose.Types.ObjectId.isValid(req.query.bookingId)) {
      return res.status(400).json({ success: false, message: "Valid bookingId required" });
    }
    const booking = await ServiceBooking.findOne({
      _id: req.query.bookingId,
      customerId: req.user.userId,
    }).lean();
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    const payment = await Payment.findOne({ bookingId: booking._id }).lean();
    const quote = await getRewardRedemptionQuote({
      customerId: req.user.userId,
      booking: { ...booking, itemType: "service" },
      payment,
      requestedCoins: req.query.coins ?? req.query.redeemCoins ?? null,
    });
    return res.json({ success: true, result: quote });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message, details: err.details });
  }
};

export const getMyRedemptions = async (req, res) => {
  try {
    ensureCustomer(req);
    const result = await getRewardRedemptions(req.user.userId, {
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/* ---------------- Admin / Owner ---------------- */

export const getRewardPolicy = async (req, res) => {
  try {
    const [active, history] = await Promise.all([
      RewardPolicy.findOne({ isActive: true }).lean(),
      RewardPolicy.find({}).select("version isActive earningEnabled redemptionEnabled rewardRateBps maxRedemptionPct minRedeemCoins redemptionReservationMinutes refundRestoresRedeemedCoins expiryMonths createdAt").sort({ version: -1 }).limit(20).lean(),
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
    const minRedeemCoins = toInt(req.body?.minRedeemCoins, 100);
    if (minRedeemCoins < 1) {
      return res.status(400).json({ success: false, message: "minRedeemCoins must be at least 1" });
    }
    const reservationMinutes = toInt(req.body?.redemptionReservationMinutes, 30);
    if (reservationMinutes < 5 || reservationMinutes > 1440) {
      return res.status(400).json({ success: false, message: "redemptionReservationMinutes must be 5..1440" });
    }
    const redemptionEnabled = req.body?.redemptionEnabled === true;
    if (redemptionEnabled && req.user?.role !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Only an Owner can enable reward redemption",
      });
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
            redemptionEnabled,
            rewardRateBps: rateBps,
            coinsPerRupee: 100,
            maxRedemptionPct,
            minRedeemCoins,
            redemptionReservationMinutes: reservationMinutes,
            refundRestoresRedeemedCoins: req.body?.refundRestoresRedeemedCoins !== false,
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
    const liability = await getRewardLiabilitySummary();
    return res.json({
      success: true,
      result: {
        byType: Object.fromEntries(byType.map((r) => [r._id, { coins: r.coins, count: r.count }])),
        wallets: wallets[0] || { wallets: 0, available: 0, reserved: 0, earned: 0 },
        outstandingRupees: ((wallets[0]?.available || 0) + (wallets[0]?.reserved || 0)) / 100,
        liability,
        capabilities: {
          earningEnabled: activePolicy?.earningEnabled ?? false,
          redemptionEnabled: activePolicy?.redemptionEnabled ?? false,
          redemptionStatus: activePolicy?.redemptionEnabled ? "enabled" : "disabled_until_accounting_approval",
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


export const adminListRedemptions = async (req, res) => {
  try {
    const result = await listRewardRedemptionsForAdmin({
      customerId: req.query.customerId,
      paymentId: req.query.paymentId,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

export const adminGetRewardReconciliation = async (req, res) => {
  try {
    const result = await getRewardLiabilitySummary();
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
