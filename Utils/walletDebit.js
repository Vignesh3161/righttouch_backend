import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";

/**
 * 🔐 ATOMIC WALLET DEBIT
 * Single source of truth for subtracting money from a technician wallet.
 *
 * H11: the old implementation read balances once (`before`) and computed
 * every cascade step from that STALE snapshot — two concurrent debits both
 * observed full balances and both subtracted, double-spending the same funds
 * (and under-counting dues). This version claims each bucket with a
 * CONDITIONAL atomic update, so concurrent callers serialize on the document:
 *   - fast path: take the full need iff the bucket currently holds it;
 *   - slow path: re-read, then take min(actual, need) iff still present.
 * A lost race yields 0 for that bucket and the remainder cascades onward, so
 * the SUM taken across buckets is always exact and dues absorb only the true
 * shortfall. WalletTransaction rows are written solely for amounts actually
 * claimed (same idempotency keys as before).
 *
 * Guarantees:
 *  - balances NEVER go negative (conditional + clamped updates);
 *  - `walletVersion` bumped on every write;
 *  - cascade order: reserveBalancePaise → availableBalancePaise →
 *    outstandingDuesPaise.
 */
const clampedSubtract = (field, amount) => ({
  $set: {
    // H11: $ifNull guards legacy documents missing the bucket — without it a
    // missing field would collapse to 0 instead of being decremented.
    [field]: { $max: [{ $subtract: [{ $ifNull: [`$${field}`, 0] }, amount] }, 0] },
    walletVersion: { $add: [{ $ifNull: ["$walletVersion", 0] }, 1] },
  },
});

// Atomically claim up to `need` paise from one balance bucket. Returns the
// amount actually claimed (0 when the bucket is empty or a racer won it).
const claimBucket = async (technicianId, field, need, opts) => {
  const want = Math.max(Math.round(need || 0), 0);
  if (want <= 0) return 0;
  const fast = await TechnicianProfile.updateOne(
    { _id: technicianId, [field]: { $gte: want } },
    [clampedSubtract(field, want)],
    opts
  );
  if (fast.modifiedCount > 0) return want;
  const current = await TechnicianProfile.findById(technicianId).select(field).lean();
  const actual = Math.max(Math.round(current?.[field]) || 0, 0);
  const take = Math.min(actual, want);
  if (take <= 0) return 0;
  const slow = await TechnicianProfile.updateOne(
    { _id: technicianId, [field]: { $gte: take } },
    [clampedSubtract(field, take)],
    opts
  );
  return slow.modifiedCount > 0 ? take : 0;
};

export const atomicWalletDebit = async ({
  technicianId,
  amountPaise,
  reason = "debit",
  idempotencyKey,
  session = null,
  allowDues = true,
}) => {
  const total = Math.max(Math.round(amountPaise || 0), 0);
  if (total === 0) return { reserve: 0, available: 0, dues: 0 };
  const opts = session ? { session } : {};

  const profileExists = await TechnicianProfile.exists({ _id: technicianId });
  if (!profileExists) return { reserve: 0, available: 0, dues: 0 };

  let remaining = total;
  const reserveTaken = await claimBucket(technicianId, "reserveBalancePaise", remaining, opts);
  remaining -= reserveTaken;

  let availableTaken = 0;
  if (remaining > 0) {
    availableTaken = await claimBucket(technicianId, "availableBalancePaise", remaining, opts);
    remaining -= availableTaken;
  }

  let duesTaken = 0;
  if (remaining > 0 && allowDues) {
    duesTaken = remaining;
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      { $inc: { outstandingDuesPaise: duesTaken, walletVersion: 1 } },
      opts
    );
    remaining = 0;
  }

  const rows = [];
  if (reserveTaken > 0)
    rows.push({ technicianId, amountPaise: reserveTaken, type: "debit", source: "refund", idempotencyKey: `${idempotencyKey}:reserve`, note: `${reason} (reserve)` });
  if (availableTaken > 0)
    rows.push({ technicianId, amountPaise: availableTaken, type: "debit", source: "refund", idempotencyKey: `${idempotencyKey}:available`, note: `${reason} (available)` });
  if (duesTaken > 0)
    rows.push({ technicianId, amountPaise: duesTaken, type: "debit", source: "refund", idempotencyKey: `${idempotencyKey}:dues`, note: `${reason} (dues)` });

  for (const r of rows) {
    try {
      await WalletTransaction.create([{ ...r, amount: null }], opts);
    } catch (e) {
      if (e?.code !== 11000) throw e; // idempotent — duplicate key => already recorded
    }
  }

  return { reserve: reserveTaken, available: availableTaken, dues: duesTaken };
};

/**
 * Clamp-only decrement of availableBalancePaise (used by payout reserve-debit
 * so the available balance can never drop below 0 even if a concurrent credit
 * is in flight). H11: returns the amount ACTUALLY debited (conditional claim),
 * never a stale-read estimate.
 */
export const safeDebitAvailable = async ({ technicianId, amountPaise, session = null }) => {
  const amt = Math.max(Math.round(amountPaise || 0), 0);
  if (amt === 0) return 0;
  const opts = session ? { session } : {};
  return claimBucket(technicianId, "availableBalancePaise", amt, opts);
};
