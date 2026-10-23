import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import Payment from "../Schemas/Payment.js";
import RewardPolicy from "../Schemas/RewardPolicy.js";
import CustomerRewardsWallet from "../Schemas/CustomerRewardsWallet.js";
import RewardTransaction from "../Schemas/RewardTransaction.js";
import RewardLot from "../Schemas/RewardLot.js";
import RewardRedemption from "../Schemas/RewardRedemption.js";
import Refund from "../Schemas/Refund.js";
import { writeAuditLog } from "../Utils/audit.js";
import { calcRedemptionPreview } from "../Utils/rewardRedemptionRules.js";

/**
 * 🪙 CUSTOMER REWARDS SERVICE (earning + payment-time redemption).
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

const MIN_PROVIDER_PAYMENT_PAISE = 100;

const httpError = (statusCode, code, message, details = null) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
};

/**
 * Calendar-month expiry (not 30-day months). Clamps to the last day of the
 * target month so Jan 31 + 1 month = Feb 28/29, not Mar 2/3.
 */
export const addCalendarMonths = (date, months) => {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Math.max(0, Number(months) || 0));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
};

const markAwardStatus = async (bookingId, status, reason = null) => {
  try {
    await ServiceBooking.updateOne(
      { _id: bookingId },
      {
        $set: {
          rewardAwardStatus: status,
          rewardAwardReason: reason,
          ...(status === "awarded" ? { rewardAwardedAt: new Date() } : {}),
        },
      }
    );
  } catch (err) {
    console.error(`[Reward] award status update failed for ${bookingId}:`, err.message);
  }
};

const notifyRewardAwarded = async (customerId, coins, bookingId) => {
  try {
    const { sendPushNotification } = await import("../Utils/sendNotification.js");
    await sendPushNotification(
      String(customerId),
      {
        title: "Reward coins added",
        body: `${coins} reward coins were added to your wallet.`,
        data: { bookingId: String(bookingId), type: "REWARD_EARNED", coins },
      },
      { recipientType: "customer" }
    );
  } catch (err) {
    console.error("[Reward] award notification failed:", err.message);
  }
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

const ensureWallet = async (customerId, session) => {
  const existing = await CustomerRewardsWallet.findOne({ customerId }).session(session);
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
    .select("_id customerId status paymentStatus settlementStatus paymentId financialSnapshot baseAmount paidAmountPaise rewardAwardStatus")
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
    await markAwardStatus(booking._id, "skipped", "fully_refunded");
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
      const expiresAt = addCalendarMonths(new Date(), policy.expiryMonths);

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
    if (result.awarded) {
      await markAwardStatus(booking._id, "awarded", result.reason);
      if (result.reason === "awarded") {
        await writeAuditLog({
          actorRole: "System",
          action: "REWARD_AWARDED",
          targetType: "ServiceBooking",
          targetId: booking._id,
          after: { customerId: booking.customerId, coins: result.coins, policyVersion: policy.version },
          metadata: { source: "rewardService" },
        }).catch(() => {});
        // Close the refund-before-award race for partial refunds: award the
        // gross entitlement first, then reverse the already-refunded share.
        if (refundedTotal > 0 && paidTotal > 0) {
          await reverseEarnedReward({
            bookingId: booking._id,
            refundId: `preaward:${booking._id}`,
            ratioBps: Math.min(10000, Math.floor((refundedTotal * 10000) / paidTotal)),
          }).catch((err) => {
            console.error(`[Reward] pre-award refund reversal failed for ${booking._id}:`, err.message);
          });
        }
        notifyRewardAwarded(booking.customerId, result.coins, booking._id);
      }
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
    .select("_id customerId bookingId coinsRemaining expiresAt")
    .sort({ expiresAt: 1, _id: 1 })
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
      if (done) {
        expired += 1;
        await writeAuditLog({
          actorRole: "System",
          action: "REWARD_EXPIRED",
          targetType: "RewardLot",
          targetId: lot._id,
          before: { coinsRemaining: lot.coinsRemaining, expiresAt: lot.expiresAt },
          after: { coinsRemaining: 0 },
          metadata: { customerId: lot.customerId, bookingId: lot.bookingId },
        }).catch(() => {});
      }
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
      restored: wallet?.lifetimeRestoredCoins ?? 0,
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
 * Expected spendable = ΣEARN + ΣRESTORE − ΣREDEEM − ΣEXPIRE − ΣREVERSAL
 * (RELEASE nets to zero: reserved→available).
 */
export const reconcileRewardWallet = async (customerId) => {
  const sums = await RewardTransaction.aggregate([
    { $match: { customerId: new mongoose.Types.ObjectId(customerId) } },
    { $group: { _id: "$type", total: { $sum: "$coins" } } },
  ]);
  const byType = Object.fromEntries(sums.map((s) => [s._id, s.total]));
  const expected =
    (byType.EARN || 0) +
    (byType.RESTORE || 0) -
    (byType.REDEEM || 0) -
    (byType.EXPIRE || 0) -
    (byType.REVERSAL || 0);
  const wallet = await CustomerRewardsWallet.findOne({ customerId }).lean();
  const actual = (wallet?.availableCoins ?? 0) + (wallet?.reservedCoins ?? 0);
  const lotAgg = await RewardLot.aggregate([
    { $match: { customerId: new mongoose.Types.ObjectId(customerId) } },
    { $group: { _id: null, remaining: { $sum: "$coinsRemaining" } } },
  ]);
  const lotRemaining = lotAgg[0]?.remaining || 0;
  return {
    ok: expected === actual,
    expected,
    actual,
    diff: actual - expected,
    byType,
    // Reserved lots are decremented at reserve time, so lot remainder must
    // equal spendable availableCoins (not available + reserved).
    lots: {
      ok: lotRemaining === (wallet?.availableCoins ?? 0),
      remaining: lotRemaining,
      available: wallet?.availableCoins ?? 0,
    },
  };
};


/* ------------------------------------------------------------------ */
/* Phase 3/4 — Redemption lifecycle (payment-time, reservation-based). */
/* ------------------------------------------------------------------ */

const redemptionKey = (paymentId) => `reward-redemption:payment:${paymentId}`;

const isTxnUnsupported = (err) => {
  const msg = String(err?.message || "");
  return msg.includes("replica set") || msg.includes("Transaction numbers") || msg.includes("mongos");
};

const runRewardTxn = async (fn) => {
  const session = await mongoose.startSession();
  try {
    try {
      return await session.withTransaction(() => fn(session));
    } catch (err) {
      if (!isTxnUnsupported(err)) throw err;
      console.warn("[Reward] NON-TRANSACTIONAL fallback — replica set required for atomic redemption");
      return await fn(null);
    }
  } finally {
    await session.endSession();
  }
};

const grossTotalOfPayment = (payment) => {
  const gross = toPaiseInt(payment?.grossTotalAmountPaise);
  if (gross > 0) return gross;
  return toPaiseInt(payment?.totalAmountPaise) + toPaiseInt(payment?.rewardDiscountPaise);
};

/**
 * Reserve the exact lots FIFO. Lots are decremented immediately so the
 * hourly expiry job can never consume coins that back an open payment.
 */
const reserveLotsForRedemption = async ({ customerId, coins, now, session }) => {
  const lots = await RewardLot.find({
    customerId,
    coinsRemaining: { $gt: 0 },
    expiresAt: { $gt: now },
  })
    .select("_id coinsRemaining expiresAt")
    .sort({ expiresAt: 1, _id: 1 })
    .session(session)
    .lean();

  let remaining = coins;
  const allocations = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.coinsRemaining, remaining);
    if (take <= 0) continue;
    const res = await RewardLot.updateOne(
      { _id: lot._id, coinsRemaining: { $gte: take } },
      { $inc: { coinsRemaining: -take } },
      { session }
    );
    if (res.modifiedCount === 1) {
      allocations.push({ lotId: lot._id, coins: take });
      remaining -= take;
    }
  }
  if (remaining > 0) {
    throw httpError(
      409,
      "REWARD_LOTS_UNAVAILABLE",
      "Reward coin lots changed while reserving — re-preview and retry",
      { requestedCoins: coins, unavailableCoins: remaining }
    );
  }
  return allocations;
};

const restoreReservedLots = async ({ allocations, session }) => {
  for (const alloc of allocations || []) {
    await RewardLot.updateOne(
      { _id: alloc.lotId },
      { $inc: { coinsRemaining: alloc.coins } },
      { session }
    );
  }
};

const releaseReservationDoc = async ({ redemption, reason, session }) => {
  if (!redemption || redemption.status !== "reserved") return false;
  await restoreReservedLots({ allocations: redemption.lotAllocations, session });
  const walletRes = await CustomerRewardsWallet.updateOne(
    { customerId: redemption.customerId, reservedCoins: { $gte: redemption.coinsReserved } },
    {
      $inc: {
        reservedCoins: -redemption.coinsReserved,
        availableCoins: redemption.coinsReserved,
        walletVersion: 1,
      },
    },
    { session }
  );
  if (walletRes.modifiedCount !== 1) {
    throw httpError(
      409,
      "REWARD_WALLET_INCONSISTENT",
      "Reserved reward balance no longer matches the reservation — reconciliation required",
      { redemptionId: String(redemption._id) }
    );
  }
  redemption.status = "released";
  redemption.releasedAt = new Date();
  redemption.releasedReason = String(reason || "released").slice(0, 200);
  await redemption.save({ session });
  await writeAuditLog({
    actorRole: "System",
    action: "REWARD_REDEMPTION_RELEASED",
    targetType: "RewardRedemption",
    targetId: redemption._id,
    before: { status: "reserved", coins: redemption.coinsReserved },
    after: { status: "released", reason: redemption.releasedReason },
    session,
  }).catch(() => {});
  return true;
};

const consumeReservedRedemption = async ({ redemption, session }) => {
  const walletRes = await CustomerRewardsWallet.updateOne(
    { customerId: redemption.customerId, reservedCoins: { $gte: redemption.coinsReserved } },
    {
      $inc: {
        reservedCoins: -redemption.coinsReserved,
        lifetimeRedeemedCoins: redemption.coinsReserved,
        walletVersion: 1,
      },
    },
    { session }
  );
  if (walletRes.modifiedCount !== 1) {
    throw httpError(
      409,
      "REWARD_WALLET_INCONSISTENT",
      "Reserved reward balance no longer matches the reservation — reconciliation required",
      { redemptionId: String(redemption._id) }
    );
  }
  const wallet = await CustomerRewardsWallet.findOne({ customerId: redemption.customerId })
    .select("availableCoins")
    .session(session)
    .lean();
  const [txn] = await RewardTransaction.create(
    [
      {
        customerId: redemption.customerId,
        bookingId: redemption.bookingId,
        paymentId: redemption.paymentId,
        redemptionId: redemption._id,
        coins: redemption.coinsReserved,
        rupees: redemption.coinsReserved / 100,
        type: "REDEEM",
        balanceAfterCoins: wallet?.availableCoins ?? 0,
        policyVersion: redemption.policyVersion,
        idempotencyKey: `reward-redeem:${redemption._id}`,
        note: `Redeemed ${redemption.coinsReserved} coins against payment ${redemption.paymentId}`,
      },
    ],
    { session }
  );
  redemption.status = "consumed";
  redemption.consumedAt = new Date();
  redemption.consumedTransactionId = txn._id;
  await redemption.save({ session });
  await writeAuditLog({
    actorRole: "System",
    action: "REWARD_REDEMPTION_CONSUMED",
    targetType: "RewardRedemption",
    targetId: redemption._id,
    before: { status: "reserved", coins: redemption.coinsReserved },
    after: { status: "consumed", transactionId: String(txn._id) },
    metadata: { paymentId: redemption.paymentId },
    session,
  }).catch(() => {});
  return { consumed: true, coins: redemption.coinsReserved, transactionId: txn._id };
};

/**
 * Quote redemption for a service booking. Pure read; disabled policies are
 * reported as ineligible rather than thrown.
 */
export const getRewardRedemptionQuote = async ({
  customerId,
  booking,
  payment = null,
  requestedCoins = null,
}) => {
  if (!booking) throw httpError(404, "BOOKING_NOT_FOUND", "Booking not found");
  if ((booking.itemType || "service") !== "service") {
    throw httpError(400, "REDEMPTION_SERVICE_ONLY", "Reward redemption is available for service bookings only");
  }
  const [policy, wallet, existingReservation] = await Promise.all([
    getActiveRewardPolicy(),
    CustomerRewardsWallet.findOne({ customerId }).lean(),
    payment?._id
      ? RewardRedemption.findOne({ paymentId: payment._id, status: "reserved" }).lean()
      : null,
  ]);
  const grossTotalAmountPaise = payment
    ? grossTotalOfPayment(payment)
    : toPaiseInt(booking?.financialSnapshot?.totalAmountPaise ?? booking?.totalAmountPaise);
  const availableCoins =
    (wallet?.availableCoins ?? 0) + (existingReservation?.coinsReserved ?? 0);

  const base = {
    bookingId: String(booking._id),
    paymentId: payment?._id ? String(payment._id) : null,
    eligible: false,
    reason: "redemption_disabled",
    eligiblePaise: toPaiseInt(booking?.financialSnapshot?.baseAmountPaise ?? Number(booking?.baseAmount || 0) * 100),
    availableCoins,
    maxRedeemableCoins: 0,
    redeemCoins: 0,
    discountPaise: 0,
    discountRupees: 0,
    payableAfterDiscountPaise: grossTotalAmountPaise,
    grossTotalAmountPaise,
    minRedeemCoins: policy?.minRedeemCoins ?? 100,
    maxRedemptionPct: policy?.maxRedemptionPct ?? 0,
    policyVersion: policy?.version ?? null,
  };

  if (!policy || !policy.redemptionEnabled) return base;
  if (booking.status !== "completed") return { ...base, reason: "booking_not_completed" };
  if (booking.paymentStatus === "paid") return { ...base, reason: "booking_already_paid" };

  const preview = calcRedemptionPreview({
    eligiblePaise: base.eligiblePaise,
    availableCoins,
    maxRedemptionPct: policy.maxRedemptionPct,
    minEligiblePaise: policy.minEligiblePaise,
    minRedeemCoins: policy.minRedeemCoins,
    totalAmountPaise: grossTotalAmountPaise,
    minPayablePaise: MIN_PROVIDER_PAYMENT_PAISE,
    requestedCoins,
  });
  return {
    ...base,
    ...preview,
    minRedeemCoins: policy.minRedeemCoins,
    maxRedemptionPct: policy.maxRedemptionPct,
    reservationMinutes: policy.redemptionReservationMinutes,
    policyVersion: policy.version,
  };
};

/**
 * Apply (or change/remove) the reward discount on a draft Payment. Called
 * before a provider order is created; no captured money may be involved.
 */
export const applyPaymentRewardDiscount = async ({ paymentId, requestedCoins = 0 }) => {
  const requested = toPaiseInt(requestedCoins);
  const payment = await Payment.findById(paymentId);
  if (!payment) throw httpError(404, "PAYMENT_NOT_FOUND", "Payment not found");
  if (payment.status === "success") {
    throw httpError(409, "PAYMENT_ALREADY_SUCCESS", "Reward discount cannot change after payment success");
  }
  if (payment.status === "manual_review") {
    throw httpError(
      409,
      "PAYMENT_UNDER_REVIEW",
      "Payment is in manual review — reward discount is locked until an admin resolves it"
    );
  }
  if (payment.providerPaymentId || payment.capturedAmountPaise != null) {
    throw httpError(409, "PAYMENT_CAPTURE_IN_PROGRESS", "Provider capture already started — reward discount is locked");
  }
  const booking = await ServiceBooking.findById(payment.bookingId).lean();
  if (!booking) throw httpError(404, "BOOKING_NOT_FOUND", "Booking not found");

  const quote = await getRewardRedemptionQuote({
    customerId: booking.customerId,
    booking: { ...booking, itemType: "service" },
    payment,
    requestedCoins: requested > 0 ? requested : null,
  });

  if (requested > 0 && !quote.eligible) {
    throw httpError(400, "REWARD_REDEMPTION_INELIGIBLE", `Reward redemption unavailable: ${quote.reason}`, quote);
  }

  const result = await runRewardTxn(async (session) => {
    const freshPayment = await Payment.findById(paymentId).session(session);
    if (!freshPayment) throw httpError(404, "PAYMENT_NOT_FOUND", "Payment not found");
    if (freshPayment.status === "success") {
      throw httpError(409, "PAYMENT_ALREADY_SUCCESS", "Reward discount cannot change after payment success");
    }
    if (freshPayment.status === "manual_review") {
      throw httpError(
        409,
        "PAYMENT_UNDER_REVIEW",
        "Payment is in manual review — reward discount is locked until an admin resolves it"
      );
    }
    const gross = grossTotalOfPayment(freshPayment);
    let redemption = await RewardRedemption.findOne({ paymentId: freshPayment._id }).session(session);

    if (redemption?.status === "consumed") {
      throw httpError(409, "REDEMPTION_ALREADY_CONSUMED", "This payment already consumed reward coins");
    }

    if (requested <= 0) {
      if (redemption) await releaseReservationDoc({ redemption, reason: "discount_removed", session });
      freshPayment.grossTotalAmountPaise = gross;
      freshPayment.rewardDiscountPaise = 0;
      freshPayment.rewardCoinsRedeemed = 0;
      freshPayment.rewardRedemptionId = null;
      freshPayment.totalAmountPaise = gross;
      freshPayment.totalAmount = gross / 100;
      await freshPayment.save({ session });
      return { payment: freshPayment, quote };
    }

    const desiredCoins = quote.redeemCoins;
    if (desiredCoins <= 0) throw httpError(400, "REWARD_REDEMPTION_INELIGIBLE", "No coins available to redeem");

    const sameReservation =
      redemption &&
      redemption.status === "reserved" &&
      redemption.coinsReserved === desiredCoins &&
      redemption.discountPaise === desiredCoins &&
      redemption.expiresAt &&
      redemption.expiresAt > new Date();
    if (sameReservation && freshPayment.rewardRedemptionId?.equals(redemption._id)) {
      return { payment: freshPayment, quote, redemption };
    }

    if (redemption?.status === "reserved") {
      await releaseReservationDoc({ redemption, reason: "discount_changed", session });
    }

    const now = new Date();
    const walletRes = await CustomerRewardsWallet.updateOne(
      { customerId: booking.customerId, availableCoins: { $gte: desiredCoins } },
      {
        $inc: {
          availableCoins: -desiredCoins,
          reservedCoins: desiredCoins,
          walletVersion: 1,
        },
      },
      { session }
    );
    if (walletRes.modifiedCount !== 1) {
      throw httpError(409, "REWARD_BALANCE_CHANGED", "Reward balance changed — re-preview and retry");
    }

    const lotAllocations = await reserveLotsForRedemption({
      customerId: booking.customerId,
      coins: desiredCoins,
      now,
      session,
    });
    const reservationMinutes = Math.max(5, toPaiseInt(quote.reservationMinutes) || 30);
    const expiresAt = new Date(now.getTime() + reservationMinutes * 60 * 1000);

    if (!redemption) {
      [redemption] = await RewardRedemption.create(
        [
          {
            customerId: booking.customerId,
            bookingId: booking._id,
            paymentId: freshPayment._id,
            coinsReserved: desiredCoins,
            discountPaise: desiredCoins,
            policyVersion: quote.policyVersion,
            status: "reserved",
            expiresAt,
            lotAllocations,
            reservationAttempts: 1,
            idempotencyKey: redemptionKey(freshPayment._id),
          },
        ],
        { session }
      );
    } else {
      redemption.coinsReserved = desiredCoins;
      redemption.discountPaise = desiredCoins;
      redemption.policyVersion = quote.policyVersion;
      redemption.status = "reserved";
      redemption.expiresAt = expiresAt;
      redemption.releasedAt = null;
      redemption.releasedReason = null;
      redemption.lotAllocations = lotAllocations;
      redemption.reservationAttempts = (redemption.reservationAttempts || 0) + 1;
      await redemption.save({ session });
    }

    freshPayment.grossTotalAmountPaise = gross;
    freshPayment.rewardDiscountPaise = desiredCoins;
    freshPayment.rewardCoinsRedeemed = desiredCoins;
    freshPayment.rewardRedemptionId = redemption._id;
    freshPayment.totalAmountPaise = Math.max(0, gross - desiredCoins);
    freshPayment.totalAmount = freshPayment.totalAmountPaise / 100;
    await freshPayment.save({ session });
    return { payment: freshPayment, quote: { ...quote, redeemCoins: desiredCoins }, redemption };
  });

  await writeAuditLog({
    actorRole: "Customer",
    action: "REWARD_REDEMPTION_RESERVED",
    targetType: "RewardRedemption",
    targetId: result.redemption?._id || paymentId,
    after: {
      paymentId: String(paymentId),
      coins: result.payment.rewardCoinsRedeemed,
      discountPaise: result.payment.rewardDiscountPaise,
    },
    metadata: { source: "payment_order" },
  }).catch(() => {});
  return result;
};

/**
 * Consume a reservation inside the payment-success transaction. If the
 * reservation expired/released while the provider order was open, re-acquire
 * coins atomically; if the customer no longer has them, fail the payment
 * transition so a human can reconcile instead of granting an unbacked discount.
 */
export const consumeRedemptionForPayment = async ({ paymentId, session }) => {
  if (!paymentId) return { consumed: false, coins: 0 };
  if (!session) {
    return runRewardTxn((s) => consumeRedemptionForPayment({ paymentId, session: s }));
  }
  const redemption = await RewardRedemption.findOne({ paymentId }).session(session);
  if (!redemption) return { consumed: false, coins: 0 };
  if (redemption.status === "consumed") {
    return { consumed: true, coins: redemption.coinsReserved, reason: "already_consumed" };
  }
  if (redemption.status === "reserved") {
    return consumeReservedRedemption({ redemption, session });
  }

  // Reservation expired/released before capture. Re-acquire the exact amount
  // from spendable coins; otherwise the discount would be unbacked.
  const now = new Date();
  const walletRes = await CustomerRewardsWallet.updateOne(
    { customerId: redemption.customerId, availableCoins: { $gte: redemption.coinsReserved } },
    {
      $inc: {
        availableCoins: -redemption.coinsReserved,
        reservedCoins: redemption.coinsReserved,
        walletVersion: 1,
      },
    },
    { session }
  );
  if (walletRes.modifiedCount !== 1) {
    throw httpError(
      409,
      "REWARD_REDEMPTION_UNAVAILABLE",
      "Reward reservation expired and the customer no longer has enough coins — payment requires manual review",
      { redemptionId: String(redemption._id), coins: redemption.coinsReserved }
    );
  }
  redemption.lotAllocations = await reserveLotsForRedemption({
    customerId: redemption.customerId,
    coins: redemption.coinsReserved,
    now,
    session,
  });
  redemption.status = "reserved";
  redemption.expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  redemption.releasedAt = null;
  redemption.releasedReason = null;
  await redemption.save({ session });
  return consumeReservedRedemption({ redemption, session });
};

/** Release a pending reservation (payment failed / order abandoned). */
export const releaseRedemptionForPayment = async ({ paymentId, reason = "payment_not_completed", session = null }) => {
  if (!paymentId) return { released: false };
  if (session) {
    const redemption = await RewardRedemption.findOne({ paymentId }).session(session);
    const released = await releaseReservationDoc({ redemption, reason, session });
    return { released, coins: released ? redemption.coinsReserved : 0 };
  }
  return runRewardTxn(async (s) => {
    const redemption = await RewardRedemption.findOne({ paymentId }).session(s);
    const released = await releaseReservationDoc({ redemption, reason, session: s });
    return { released, coins: released ? redemption.coinsReserved : 0 };
  });
};

/**
 * Release abandoned reservations. Payments in manual_review stay reserved
 * until an operator resolves them; successful pending captures are consumed
 * immediately instead of released.
 */
export const expireRedemptionReservations = async ({ now = new Date(), limit = 200 } = {}) => {
  const summary = { scanned: 0, released: 0, consumed: 0, held: 0, failed: [] };
  const rows = await RewardRedemption.find({ status: "reserved", expiresAt: { $lte: now } })
    .select("_id paymentId customerId coinsReserved")
    .sort({ expiresAt: 1, _id: 1 })
    .limit(limit)
    .lean();
  for (const row of rows) {
    summary.scanned += 1;
    try {
      const outcome = await runRewardTxn(async (session) => {
        const payment = row.paymentId
          ? await Payment.findById(row.paymentId).select("status").session(session).lean()
          : null;
        if (payment?.status === "manual_review") return "held";
        if (payment?.status === "success") {
          await consumeRedemptionForPayment({ paymentId: row.paymentId, session });
          return "consumed";
        }
        const redemption = await RewardRedemption.findById(row._id).session(session);
        const released = await releaseReservationDoc({
          redemption,
          reason: "reservation_expired",
          session,
        });
        return released ? "released" : "held";
      });
      if (outcome === "released") summary.released += 1;
      else if (outcome === "consumed") summary.consumed += 1;
      else summary.held += 1;
    } catch (err) {
      summary.failed.push({ redemptionId: String(row._id), reason: err.message });
      console.error(`[RewardRedemption] expiry ${row._id}:`, err.message);
    }
  }
  return summary;
};

/**
 * Refund restoration: return the proportional share of consumed coins as a
 * fresh lot. Cumulative restores per redemption are capped at what was spent.
 */
export const restoreRedeemedCoinsForRefund = async ({ paymentId, refundId, ratioBps = 10000 }) => {
  const redemption = await RewardRedemption.findOne({ paymentId, status: "consumed" }).lean();
  if (!redemption) return { restored: false, coins: 0, reason: "no_consumed_redemption" };
  const policy = await getActiveRewardPolicy();
  if (policy && policy.refundRestoresRedeemedCoins === false) {
    return { restored: false, coins: 0, reason: "policy_forbids_restore" };
  }
  const ratio = Math.max(0, Math.min(10000, toPaiseInt(ratioBps)));
  const wanted = Math.floor((redemption.coinsReserved * ratio) / 10000);
  if (wanted <= 0) return { restored: false, coins: 0, reason: "zero_restore" };
  const idempotencyKey = `reward-restore:${refundId}`;
  const existing = await RewardTransaction.findOne({ idempotencyKey }).lean();
  if (existing) return { restored: true, coins: existing.coins, reason: "already_restored" };

  return runRewardTxn(async (session) => {
    const dup = await RewardTransaction.findOne({ idempotencyKey }).session(session);
    if (dup) return { restored: true, coins: dup.coins, reason: "already_restored" };
    const agg = await RewardTransaction.aggregate([
      { $match: { redemptionId: redemption._id, type: "RESTORE" } },
      { $group: { _id: null, total: { $sum: "$coins" } } },
    ]).session(session);
    const restoredSoFar = agg[0]?.total || 0;
    const remaining = Math.max(0, redemption.coinsReserved - restoredSoFar);
    const coins = Math.min(wanted, remaining);
    if (coins <= 0) return { restored: true, coins: 0, reason: "cap_reached" };

    await CustomerRewardsWallet.updateOne(
      { customerId: redemption.customerId },
      {
        $inc: {
          availableCoins: coins,
          lifetimeRestoredCoins: coins,
          walletVersion: 1,
        },
      },
      { session }
    );
    const earn = await RewardTransaction.findOne({ bookingId: redemption.bookingId, type: "EARN" })
      .select("_id policyVersion")
      .session(session)
      .lean();
    const [lot] = await RewardLot.create(
      [
        {
          customerId: redemption.customerId,
          bookingId: redemption.bookingId,
          earnTransactionId: earn?._id || null,
          coinsTotal: coins,
          coinsRemaining: coins,
          earnedAt: new Date(),
          expiresAt: addCalendarMonths(new Date(), policy?.expiryMonths || 12),
          policyVersion: redemption.policyVersion,
        },
      ],
      { session }
    );
    const wallet = await CustomerRewardsWallet.findOne({ customerId: redemption.customerId })
      .select("availableCoins")
      .session(session)
      .lean();
    const [txn] = await RewardTransaction.create(
      [
        {
          customerId: redemption.customerId,
          bookingId: redemption.bookingId,
          paymentId,
          redemptionId: redemption._id,
          coins,
          rupees: coins / 100,
          type: "RESTORE",
          balanceAfterCoins: wallet?.availableCoins ?? 0,
          policyVersion: redemption.policyVersion,
          idempotencyKey,
          note: `Restored ${coins} redeemed coins after refund ${refundId} (fresh lot ${lot._id})`,
        },
      ],
      { session }
    );
    await writeAuditLog({
      actorRole: "System",
      action: "REWARD_REDEMPTION_RESTORED",
      targetType: "RewardRedemption",
      targetId: redemption._id,
      after: { coins, refundId: String(refundId), transactionId: String(txn._id) },
      metadata: { source: "refund" },
      session,
    }).catch(() => {});
    return { restored: true, coins, transactionId: txn._id };
  });
};

/** Customer redemption history. */
export const getRewardRedemptions = async (customerId, { page = 1, limit = 20 } = {}) => {
  const { pageNum, limitNum } = toPageLimit(page, limit);
  const filter = { customerId };
  const [items, total] = await Promise.all([
    RewardRedemption.find(filter)
      .select("bookingId paymentId coinsReserved discountPaise status expiresAt consumedAt releasedAt createdAt")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    RewardRedemption.countDocuments(filter),
  ]);
  return { items, total, page: pageNum, limit: limitNum };
};

/** Admin/Owner redemption search (support + liability review). */
export const listRewardRedemptionsForAdmin = async ({
  customerId = null,
  paymentId = null,
  status = null,
  page = 1,
  limit = 20,
} = {}) => {
  const filter = {};
  if (customerId) {
    if (!mongoose.Types.ObjectId.isValid(customerId)) throw httpError(400, "INVALID_CUSTOMER_ID", "Invalid customerId");
    filter.customerId = new mongoose.Types.ObjectId(customerId);
  }
  if (paymentId) {
    if (!mongoose.Types.ObjectId.isValid(paymentId)) throw httpError(400, "INVALID_PAYMENT_ID", "Invalid paymentId");
    filter.paymentId = new mongoose.Types.ObjectId(paymentId);
  }
  if (status) {
    if (!["reserved", "consumed", "released", "expired"].includes(status)) {
      throw httpError(400, "INVALID_STATUS", "Invalid redemption status");
    }
    filter.status = status;
  }
  const { pageNum, limitNum } = toPageLimit(page, limit);
  const [items, total] = await Promise.all([
    RewardRedemption.find(filter)
      .select("customerId bookingId paymentId coinsReserved discountPaise status expiresAt consumedAt releasedAt reservationAttempts createdAt")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    RewardRedemption.countDocuments(filter),
  ]);
  return { items, total, page: pageNum, limit: limitNum };
};

/** Liability snapshot for Admin/Owner dashboards. */
export const getRewardLiabilitySummary = async () => {
  const [walletAgg, redemptionAgg, lotAgg] = await Promise.all([
    CustomerRewardsWallet.aggregate([
      {
        $group: {
          _id: null,
          wallets: { $sum: 1 },
          available: { $sum: "$availableCoins" },
          reserved: { $sum: "$reservedCoins" },
          redeemed: { $sum: "$lifetimeRedeemedCoins" },
          restored: { $sum: "$lifetimeRestoredCoins" },
          expired: { $sum: "$lifetimeExpiredCoins" },
          reversed: { $sum: "$lifetimeReversedCoins" },
        },
      },
    ]),
    RewardRedemption.aggregate([{ $group: { _id: "$status", coins: { $sum: "$coinsReserved" }, count: { $sum: 1 } } }]),
    RewardLot.aggregate([
      { $group: { _id: null, remaining: { $sum: "$coinsRemaining" }, lots: { $sum: 1 } } },
    ]),
  ]);
  const wallets = walletAgg[0] || {
    wallets: 0, available: 0, reserved: 0, redeemed: 0, restored: 0, expired: 0, reversed: 0,
  };
  return {
    wallets,
    redemptions: Object.fromEntries(redemptionAgg.map((r) => [r._id, { coins: r.coins, count: r.count }])),
    lots: lotAgg[0] || { remaining: 0, lots: 0 },
    outstandingCoins: wallets.available + wallets.reserved,
    outstandingRupees: (wallets.available + wallets.reserved) / 100,
    lifetimeRedeemedCoins: wallets.redeemed - wallets.restored,
  };
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
    // Terminal statuses advance the scan window; legacy documents missing
    // the field remain eligible. This prevents the old starvation bug where
    // the first 100 already-awarded _ids were re-read forever.
    rewardAwardStatus: { $nin: ["awarded", "skipped"] },
  })
    .select("_id")
    .sort({ _id: 1 })
    .limit(limit)
    .lean();

  for (const c of candidates) {
    summary.scanned += 1;
    try {
      const result = await awardServiceReward(c._id);
      if (!result.awarded) {
        if (result.reason === "fully_refunded") summary.skippedRefunded += 1;
        else summary.failed.push({ bookingId: String(c._id), reason: result.reason });
        continue;
      }
      if (result.reason === "already_awarded") summary.alreadyAwarded += 1;
      else summary.awarded += 1;
    } catch (err) {
      summary.failed.push({ bookingId: String(c._id), reason: err.message });
      console.error(`[RewardRecovery] booking ${c._id}:`, err.message);
    }
  }

  // Backward-compatible operational metric: when the backlog is clear,
  // report how many settled bookings already carry a terminal award.
  if (candidates.length === 0) {
    summary.alreadyAwarded = await ServiceBooking.countDocuments({
      settlementStatus: "settled",
      status: "completed",
      paymentStatus: "paid",
      rewardAwardStatus: "awarded",
    });
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

const ADMIN_TXN_TYPES = ["EARN", "REDEEM", "RELEASE", "RESTORE", "EXPIRE", "REVERSAL"];

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
      .select("customerId availableCoins reservedCoins lifetimeEarnedCoins lifetimeRedeemedCoins lifetimeExpiredCoins lifetimeReversedCoins lifetimeRestoredCoins updatedAt createdAt")
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
      .select("customerId availableCoins reservedCoins lifetimeEarnedCoins lifetimeRedeemedCoins lifetimeExpiredCoins lifetimeReversedCoins lifetimeRestoredCoins updatedAt createdAt")
      .lean(),
  ]);
  return { customerId: String(customerId), balance, reconcile, wallet };
};
