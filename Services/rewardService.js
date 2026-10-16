import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import Payment from "../Schemas/Payment.js";
import RewardPolicy from "../Schemas/RewardPolicy.js";
import CustomerRewardsWallet from "../Schemas/CustomerRewardsWallet.js";
import RewardTransaction from "../Schemas/RewardTransaction.js";
import RewardLot from "../Schemas/RewardLot.js";
import Refund from "../Schemas/Refund.js";
import { writeAuditLog } from "../Utils/audit.js";

/**
 * 🪙 CUSTOMER REWARDS SERVICE (earn-first release; redemption deferred).
 *
 * Promotional coins only: 100 coins == ₹1 (1 coin == 1 paise of reward
 * value). Integer arithmetic throughout — no floating point on balances.
 *
 * Earning rule: booking completed AND authoritative payment success.
 * Called best-effort AFTER technician settlement commits; a reward failure
 * never blocks or undoes settlement. Retries duplicate webhooks settle on
 * the same idempotency keys.
 */

const toPaiseInt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
};

export const getActiveRewardPolicy = () =>
  RewardPolicy.findOne({ isActive: true }).lean();

/**
 * Pure calculation: floor(eligiblePaise * rateBps / 10000), capped.
 * Returns { coins, eligiblePaise, rateBps } — coins == paise of value.
 */
export const calcRewardCoins = (eligiblePaise, policy) => {
  const eligible = toPaiseInt(eligiblePaise);
  const raw = Math.floor((eligible * policy.rewardRateBps) / 10000);
  const capped =
    policy.maxCoinsPerBooking != null
      ? Math.min(raw, policy.maxCoinsPerBooking)
      : raw;
  return { coins: Math.max(0, capped), eligiblePaise: eligible, rateBps: policy.rewardRateBps };
};

const ensureWallet = async (customerId, session) => {  const existing = await CustomerRewardsWallet.findOne({ customerId }).session(session);
  if (existing) return existing;
  try {
    const [created] = await CustomerRewardsWallet.create(
      [{ customerId }],
      { session }
    );
    return created;
  } catch (e) {
    if (e?.code !== 11000) throw e;
    return CustomerRewardsWallet.findOne({ customerId }).session(session);
  }
};

/**
 * Award coins for one eligible service booking. Idempotent:
 * "service-reward:<bookingId>" txn key + uniq_earn_per_booking index.
 * Returns { awarded, coins, reason } — never throws for business
 * ineligibility (only for unexpected DB errors).
 */
export const awardServiceReward = async (bookingId) => {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    return { awarded: false, coins: 0, reason: "invalid_bookingId" };
  }
  const policy = await getActiveRewardPolicy();
  if (!policy || !policy.earningEnabled) {
    return { awarded: false, coins: 0, reason: "program_disabled" };
  }
  const booking = await ServiceBooking.findById(bookingId)
    .select("_id customerId status paymentStatus settlementStatus paymentId financialSnapshot baseAmount")
    .lean();
  if (!booking) return { awarded: false, coins: 0, reason: "booking_not_found" };
  if (booking.status !== "completed" || booking.paymentStatus !== "paid") {
    return { awarded: false, coins: 0, reason: "not_completed_paid" };
  }
  // Authoritative payment record — same rule as settlement.
  let payment = null;
  if (booking.paymentId) payment = await Payment.findById(booking.paymentId).lean();
  if (!payment) payment = await Payment.findOne({ bookingId: booking._id }).lean();
  if (!payment || payment.status !== "success") {
    return { awarded: false, coins: 0, reason: "payment_not_success" };
  }
  // Eligible basis: authoritative service subtotal, tips/tax/discounts out.
  const eligible = toPaiseInt(
    booking.financialSnapshot?.baseAmountPaise ?? booking.baseAmount * 100
  );
  if (eligible < toPaiseInt(policy.minEligiblePaise)) {
    return { awarded: false, coins: 0, reason: "below_minimum" };
  }
  const { coins } = calcRewardCoins(eligible, policy);
  if (coins <= 0) return { awarded: false, coins: 0, reason: "zero_reward" };

  // P1: refund-before-award — a fully refunded booking must not earn late
  // rewards (e.g. refund processed before settlement completed).
  const processedRefunds = await Refund.find({ bookingId: booking._id, status: "processed" })
    .select("netRefundPaise")
    .lean();
  const refundedTotal = processedRefunds.reduce((a, r) => a + toPaiseInt(r.netRefundPaise), 0);
  const paidTotal = toPaiseInt(payment.totalAmountPaise ?? booking.paidAmountPaise);
  if (paidTotal > 0 && refundedTotal >= paidTotal) {
    return { awarded: false, coins: 0, reason: "fully_refunded" };
  }

  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const idempotencyKey = `service-reward:${booking._id}`;
      // In-txn recheck: a concurrent award may have posted while this run
      // was working — return its outcome instead of hitting E11000.
      const dup = await RewardTransaction.findOne({ idempotencyKey }).session(session);
      if (dup) return { awarded: true, coins: dup.coins, reason: "already_awarded" };
      const wallet = await ensureWallet(booking.customerId, session);
      const expiresAt = new Date(Date.now() + policy.expiryMonths * 30 * 24 * 60 * 60 * 1000);

      const [txn] = await RewardTransaction.create(
        [
          {
            customerId: booking.customerId,
            bookingId: booking._id,
            coins,
            rupees: coins / 100,
            type: "EARN",
            policyVersion: policy.version,
            calcInputs: { eligiblePaise: eligible, rateBps: policy.rewardRateBps },
            idempotencyKey,
            note: `Reward for completed service booking ${booking._id}`,
          },
        ],
        { session }
      );
      const [lot] = await RewardLot.create(
        [
          {
            customerId: booking.customerId,
            bookingId: booking._id,
            earnTransactionId: txn._id,
            coinsTotal: coins,
            coinsRemaining: coins,
            earnedAt: new Date(),
            expiresAt,
            policyVersion: policy.version,
          },
        ],
        { session }
      );
      txn.balanceAfterCoins = wallet.availableCoins + coins;
      await txn.save({ session });
      await CustomerRewardsWallet.updateOne(
        { _id: wallet._id },
        {
          $inc: {
            availableCoins: coins,
            lifetimeEarnedCoins: coins,
            walletVersion: 1,
          },
        },
        { session }
      );
      // P0 follow-up: re-read the committed balance so the audit field is
      // exact even when concurrent awards for other bookings interleave.
      const walletAfter = await CustomerRewardsWallet.findById(wallet._id)
        .select("availableCoins")
        .session(session)
        .lean();
      if (walletAfter && walletAfter.availableCoins !== txn.balanceAfterCoins) {
        txn.balanceAfterCoins = walletAfter.availableCoins;
        await txn.save({ session });
      }
      return { awarded: true, coins, reason: "awarded", lotId: lot._id };
    });
    if (result.awarded && result.reason === "awarded") {
      await writeAuditLog({
        actorRole: "System",
        action: "REWARD_AWARDED",
        targetType: "ServiceBooking",
        targetId: booking._id,
        after: { customerId: booking.customerId, coins: result.coins, policyVersion: policy.version },
        metadata: { source: "rewardService" },
      }).catch(() => {});
    }
    return result;
  } finally {
    await session.endSession();
  }
};

/**
 * P0 helper — decrement a wallet counter by ACTUAL committed amount.
 * Re-reads authoritative state and retries (bounded) when a concurrent
 * worker wins the race. Returns { taken, balanceAfter }. The caller MUST
 * record `taken` (not the requested amount) in its ledger entry.
 */
const decrementWalletCoins = async ({
  customerId,
  wantCoins,
  counterField,
  session,
  maxAttempts = 3,
}) => {
  let want = Math.max(0, Math.floor(wantCoins));
  for (let i = 0; i < maxAttempts && want > 0; i++) {
    const wallet = await CustomerRewardsWallet.findOne({ customerId }).session(session);
    if (!wallet) return { taken: 0, balanceAfter: null };
    const take = Math.min(wallet.availableCoins, want);
    if (take <= 0) return { taken: 0, balanceAfter: wallet.availableCoins };
    const res = await CustomerRewardsWallet.updateOne(
      { _id: wallet._id, availableCoins: { $gte: take } },
      { $inc: { availableCoins: -take, [counterField]: take, walletVersion: 1 } },
      { session }
    );
    if (res.modifiedCount === 1) {
      const fresh = await CustomerRewardsWallet.findById(wallet._id)
        .select("availableCoins")
        .session(session)
        .lean();
      return { taken: take, balanceAfter: fresh ? fresh.availableCoins : wallet.availableCoins - take };
    }
    want = take; // lost race — re-read and retry with fresh state
  }
  const wallet = await CustomerRewardsWallet.findOne({ customerId }).session(session);
  return { taken: 0, balanceAfter: wallet ? wallet.availableCoins : null };
};

/**
 * P0 helper — decrement a lot's remaining coins by ACTUAL committed amount.
 * Returns the committed decrement (0 when a concurrent worker trimmed it).
 */
const decrementLotCoins = async ({ lotId, wantCoins, session, maxAttempts = 3 }) => {
  let want = Math.max(0, Math.floor(wantCoins));
  for (let i = 0; i < maxAttempts && want > 0; i++) {
    const lot = await RewardLot.findById(lotId).select("coinsRemaining").session(session);
    if (!lot || lot.coinsRemaining <= 0) return 0;
    const take = Math.min(lot.coinsRemaining, want);
    const res = await RewardLot.updateOne(
      { _id: lotId, coinsRemaining: { $gte: take } },
      { $inc: { coinsRemaining: -take } },
      { session }
    );
    if (res.modifiedCount === 1) return take;
    want = take;
  }
  return 0;
};
/**
 * Reverse earned coins after a processed refund. Compensating REVERSAL
 * entry + originating-lot decrement + guarded wallet decrement.
 * `ratioBps`: 10000 = full reversal (proportional for partial refunds —
 * proposed default, requires finance sign-off).
 *
 * Cumulative cap: SUM(REVERSAL.coins) for the earn never exceeds earned
 * coins, regardless of overlapping partials — enforced in-transaction
 * from posted history (not request ratios).
 *
 * P0: every guarded update's matchedCount is checked and the ledger entry
 * records ACTUAL committed amounts (re-read post-update), never intended
 * ones. In-txn idempotency recheck prevents duplicate-key aborts under
 * concurrent same-refund reversals.
 */
export const reverseEarnedReward = async ({ bookingId, refundId, ratioBps = 10000 }) => {
  const earn = await RewardTransaction.findOne({
    bookingId,
    type: "EARN",
  }).lean();
  if (!earn) return { reversed: false, coins: 0, reason: "no_earn_found" };
  const coins = Math.floor((earn.coins * Math.max(0, Math.min(10000, ratioBps))) / 10000);
  if (coins <= 0) return { reversed: false, coins: 0, reason: "zero_reversal" };
  const idempotencyKey = `reward-reversal:${refundId}`;
  const existing = await RewardTransaction.findOne({ idempotencyKey }).lean();
  if (existing) return { reversed: true, coins: existing.coins, reason: "already_reversed" };

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      // In-txn recheck: a concurrent same-refund reversal may have posted
      // while this run was working — return its outcome, no duplicate key.
      const dup = await RewardTransaction.findOne({ idempotencyKey }).session(session);
      if (dup) return { reversed: true, coins: dup.coins, reason: "already_reversed" };
      // Cumulative cap: total REVERSAL coins for this earn must never exceed
      // earned coins, no matter how many overlapping partial refunds arrive.
      // Computed in-txn from posted history (not from the request ratio).
      const reversedAgg = await RewardTransaction.aggregate([
        { $match: { bookingId: earn.bookingId, type: "REVERSAL" } },
        { $group: { _id: null, total: { $sum: "$coins" } } },
      ]).session(session);
      const reversedSoFar = reversedAgg[0]?.total || 0;
      const remaining = Math.max(0, earn.coins - reversedSoFar);
      if (remaining <= 0) {
        return { reversed: true, coins: 0, reason: "cap_reached" };
      }
      const capped = Math.min(coins, remaining);
      const lot = await RewardLot.findOne({ bookingId, earnTransactionId: earn._id }).session(session);
      const lotTaken = lot ? await decrementLotCoins({ lotId: lot._id, wantCoins: Math.min(lot.coinsRemaining, capped), session }) : 0;
      const shortfall = capped - lotTaken;
      const { taken, balanceAfter } = await decrementWalletCoins({
        customerId: earn.customerId,
        wantCoins: capped,
        counterField: "lifetimeReversedCoins",
        session,
      });
      const [txn] = await RewardTransaction.create(
        [
          {
            customerId: earn.customerId,
            bookingId,
            coins: taken,
            rupees: taken / 100,
            type: "REVERSAL",
            policyVersion: earn.policyVersion,
            idempotencyKey,
            balanceAfterCoins: balanceAfter,
            note: `Reversal for refund ${refundId}${shortfall > 0 ? ` (shortfall ${shortfall} — coins already consumed)` : ""}${
              taken < capped - shortfall ? ` (wallet contention — committed ${taken} of ${capped})` : ""
            }${capped < coins ? ` (capped at ${capped} of ${coins} — cumulative reversals limited to earned ${earn.coins})` : ""}`,
          },
        ],
        { session }
      );
      return { reversed: true, coins: taken, shortfall, txnId: txn._id, capped };
    });
  } finally {
    await session.endSession();
  }
};

/**
 * Expire eligible lots (FIFO accounting lives in the lots themselves).
 * Idempotent per lot via "reward-expire:<lotId>".
 */
export const expireRewards = async ({ now = new Date(), limit = 200 } = {}) => {
  const lots = await RewardLot.find({ expiresAt: { $lte: now }, coinsRemaining: { $gt: 0 } })
    .select("_id customerId bookingId coinsRemaining")
    .limit(limit)
    .lean();
  let expired = 0;
  for (const lot of lots) {
    const session = await mongoose.startSession();
    try {
      const done = await session.withTransaction(async () => {
        const idempotencyKey = `reward-expire:${lot._id}`;
        if (await RewardTransaction.findOne({ idempotencyKey }).session(session)) return false;
        // P0: commit the ACTUAL decrement and record exactly that amount.
        const taken = await decrementLotCoins({ lotId: lot._id, wantCoins: lot.coinsRemaining, session });
        if (taken <= 0) return false;
        const { taken: walletTaken, balanceAfter } = await decrementWalletCoins({
          customerId: lot.customerId,
          wantCoins: taken,
          counterField: "lifetimeExpiredCoins",
          session,
        });
        await RewardTransaction.create(
          [
            {
              customerId: lot.customerId,
              bookingId: lot.bookingId,
              coins: walletTaken,
              rupees: walletTaken / 100,
              type: "EXPIRE",
              idempotencyKey,
              balanceAfterCoins: balanceAfter,
              note: `Expiry of lot ${lot._id}${walletTaken < taken ? ` (wallet contention — committed ${walletTaken} of ${taken})` : ""}`,
            },
          ],
          { session }
        );
        return true;
      });
      if (done) expired += 1;
    } catch (e) {
      if (e?.code !== 11000) console.error(`[RewardExpiry] lot ${lot._id}:`, e.message);
    } finally {
      await session.endSession();
    }
  }
  return { scanned: lots.length, expired };
};

/** Balance + rupee equivalent (read-only). */
export const getRewardBalance = async (customerId) => {
  const wallet = await CustomerRewardsWallet.findOne({ customerId }).lean();
  const available = wallet?.availableCoins ?? 0;
  return {
    availableCoins: available,
    reservedCoins: wallet?.reservedCoins ?? 0,
    rupees: available / 100,
    lifetime: {
      earned: wallet?.lifetimeEarnedCoins ?? 0,
      redeemed: wallet?.lifetimeRedeemedCoins ?? 0,
      expired: wallet?.lifetimeExpiredCoins ?? 0,
      reversed: wallet?.lifetimeReversedCoins ?? 0,
    },
  };
};

/** Paginated history, newest first, bounded limit. */
export const getRewardHistory = async (customerId, { page = 1, limit = 20 } = {}) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const [items, total] = await Promise.all([
    RewardTransaction.find({ customerId })
      .select("bookingId coins rupees type balanceAfterCoins policyVersion status note createdAt")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    RewardTransaction.countDocuments({ customerId }),
  ]);
  return { items, total, page: pageNum, limit: limitNum };
};

/**
 * Reconciliation: posted ledger vs wallet (read-only).
 * Expected spendable = ΣEARN − ΣREDEEM − ΣEXPIRE − ΣREVERSAL
 * (RELEASE nets to zero: reserved→available).
 */
export const reconcileRewardWallet = async (customerId) => {
  const sums = await RewardTransaction.aggregate([
    { $match: { customerId: new mongoose.Types.ObjectId(customerId) } },
    { $group: { _id: "$type", total: { $sum: "$coins" } } },
  ]);
  const byType = Object.fromEntries(sums.map((s) => [s._id, s.total]));
  const expected =
    (byType.EARN || 0) -
    (byType.REDEEM || 0) -
    (byType.EXPIRE || 0) -
    (byType.REVERSAL || 0);
  const wallet = await CustomerRewardsWallet.findOne({ customerId }).lean();
  const actual = (wallet?.availableCoins ?? 0) + (wallet?.reservedCoins ?? 0);
  return { ok: expected === actual, expected, actual, diff: actual - expected, byType };
};

/**
 * P1 — MISSED-AWARD RECOVERY (bounded, idempotent, concurrency-safe).
 *
 * Recovers bookings the post-settlement hook missed (hook failure, crash
 * between settlement commit and award, standalone-fallback path). Only
 * settled bookings are scanned — settlement already proved
 * completed+paid+success+snapshot-match, so this job re-verifies cheaply
 * via awardServiceReward itself.
 *
 * Fully-refunded bookings are skipped (reported, never awarded). Partially
 * refunded bookings are awarded then reversed proportionally under a
 * stable synthetic key (`reward-reversal:recovery:<bookingId>`), closing
 * the award/refund race in either order. Repeated and concurrent runs are
 * safe: award + reversal are both idempotent.
 */
export const recoverMissedRewards = async ({ limit = 100 } = {}) => {
  const summary = { scanned: 0, awarded: 0, alreadyAwarded: 0, skippedRefunded: 0, failed: [] };
  const candidates = await ServiceBooking.find({
    settlementStatus: "settled",
    status: "completed",
    paymentStatus: "paid",
  })
    .select("_id")
    .sort({ _id: 1 })
    .limit(limit)
    .lean();
  for (const c of candidates) {
    try {
      const hasEarn = await RewardTransaction.exists({ bookingId: c._id, type: "EARN" });
      if (hasEarn) {
        summary.alreadyAwarded += 1;
        continue;
      }
      summary.scanned += 1;
      const result = await awardServiceReward(c._id);
      if (!result.awarded) {
        if (result.reason === "fully_refunded") summary.skippedRefunded += 1;
        else summary.failed.push({ bookingId: String(c._id), reason: result.reason });
        continue;
      }
      // Partial-refund aftermath: award first, then reverse the refunded
      // share (stable key → reruns and races collapse).
      const processed = await Refund.find({ bookingId: c._id, status: "processed" })
        .select("netRefundPaise")
        .lean();
      const refundedTotal = processed.reduce((a, r) => a + toPaiseInt(r.netRefundPaise), 0);
      if (refundedTotal > 0) {
        const booking = await ServiceBooking.findById(c._id)
          .select("paidAmountPaise paymentId")
          .lean();
        let paidTotal = toPaiseInt(booking?.paidAmountPaise);
        if (!paidTotal && booking?.paymentId) {
          const pay = await Payment.findById(booking.paymentId).select("totalAmountPaise").lean();
          paidTotal = toPaiseInt(pay?.totalAmountPaise);
        }
        if (paidTotal > 0) {
          await reverseEarnedReward({
            bookingId: c._id,
            refundId: `recovery:${c._id}`,
            ratioBps: Math.min(10000, Math.floor((refundedTotal * 10000) / paidTotal)),
          });
        }
      }
      summary.awarded += 1;
    } catch (err) {
      summary.failed.push({ bookingId: String(c._id), reason: err.message });
      console.error(`[RewardRecovery] booking ${c._id}:`, err.message);
    }
  }
  return summary;
};

export const toRewardResult = (r) => ({
  awarded: r.awarded,
  coins: r.coins,
  rupees: r.coins / 100,
  reason: r.reason,
});

/* ------------------------------------------------------------------ */
/* Phase 1 — Admin read helpers (read-only, no state change).          */
/* Reuses existing ledger/wallet reads for the Reward Management page. */
/* No redemption behavior lives here; redemption stays disabled.      */
/* ------------------------------------------------------------------ */

const ADMIN_TXN_TYPES = ["EARN", "REDEEM", "RELEASE", "EXPIRE", "REVERSAL"];

const toPageLimit = (page, limit) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  return { pageNum, limitNum };
};

/**
 * Paginated global reward-ledger search for Admin/Owner support.
 * Allowlisted filters only — never passes raw query objects to Mongo.
 */
export const listRewardTransactionsForAdmin = async ({
  customerId = null,
  bookingId = null,
  type = null,
  page = 1,
  limit = 20,
} = {}) => {
  const filter = {};
  if (customerId != null && customerId !== "") {
    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      const err = new Error("Invalid customerId");
      err.statusCode = 400;
      throw err;
    }
    filter.customerId = new mongoose.Types.ObjectId(customerId);
  }
  if (bookingId != null && bookingId !== "") {
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      const err = new Error("Invalid bookingId");
      err.statusCode = 400;
      throw err;
    }
    filter.bookingId = new mongoose.Types.ObjectId(bookingId);
  }
  if (type != null && type !== "") {
    if (!ADMIN_TXN_TYPES.includes(type)) {
      const err = new Error(`Invalid type — must be one of ${ADMIN_TXN_TYPES.join(", ")}`);
      err.statusCode = 400;
      throw err;
    }
    filter.type = type;
  }
  const { pageNum, limitNum } = toPageLimit(page, limit);
  const [items, total] = await Promise.all([
    RewardTransaction.find(filter)
      .select("customerId bookingId coins rupees type balanceAfterCoins policyVersion status note createdAt")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    RewardTransaction.countDocuments(filter),
  ]);
  return { items, total, page: pageNum, limit: limitNum };
};

const ADMIN_WALLET_SORTS = {
  availableCoins: { availableCoins: -1 },
  lifetimeEarnedCoins: { lifetimeEarnedCoins: -1 },
  updatedAt: { updatedAt: -1 },
  createdAt: { createdAt: -1 },
};

/**
 * Paginated wallet overview for Admin/Owner (liability breakdown).
 * `minAvailableCoins` filters thin wallets out of the support view.
 */
export const listRewardWalletsForAdmin = async ({
  page = 1,
  limit = 20,
  sort = "updatedAt",
  minAvailableCoins = 0,
} = {}) => {
  const { pageNum, limitNum } = toPageLimit(page, limit);
  const sortSpec = ADMIN_WALLET_SORTS[sort] || ADMIN_WALLET_SORTS.updatedAt;
  const minAvail = Math.max(0, Math.floor(Number(minAvailableCoins) || 0));
  const filter = minAvail > 0 ? { availableCoins: { $gte: minAvail } } : {};
  const [items, total] = await Promise.all([
    CustomerRewardsWallet.find(filter)
      .select("customerId availableCoins reservedCoins lifetimeEarnedCoins lifetimeRedeemedCoins lifetimeExpiredCoins lifetimeReversedCoins updatedAt createdAt")
      .sort(sortSpec)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    CustomerRewardsWallet.countDocuments(filter),
  ]);
  return { items, total, page: pageNum, limit: limitNum };
};

/**
 * Per-customer support view: balance + reconciliation + wallet doc.
 * Returns zeros + wallet:null when the customer never earned (no 404,
 * so support can distinguish "never earned" from errors).
 */
export const getCustomerRewardOverview = async (customerId) => {
  if (!mongoose.Types.ObjectId.isValid(customerId)) {
    const err = new Error("Invalid customerId");
    err.statusCode = 400;
    throw err;
  }
  const [balance, reconcile, wallet] = await Promise.all([
    getRewardBalance(customerId),
    reconcileRewardWallet(customerId),
    CustomerRewardsWallet.findOne({ customerId })
      .select("customerId availableCoins reservedCoins lifetimeEarnedCoins lifetimeRedeemedCoins lifetimeExpiredCoins lifetimeReversedCoins updatedAt createdAt")
      .lean(),
  ]);
  return { customerId: String(customerId), balance, reconcile, wallet };
};
