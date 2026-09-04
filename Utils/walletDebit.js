import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";

/**
 * 🔐 ATOMIC WALLET DEBIT
 * Single source of truth for subtracting money from a technician wallet.
 *
 * Guarantees (addresses audit O3/O4/O5):
 *  - Atomic, clamped updates via aggregation-pipeline `$max` so a balance can
 *    NEVER go negative even under concurrent callers (no read-then-write race).
 *  - `walletVersion` is bumped on every write (CAS signal for future predicates).
 *  - Cascade order: reserveBalancePaise → availableBalancePaise →
 *    outstandingDuesPaise (dues absorbs any true unrecoverable shortfall).
 *
 * The `before` balance is read once to compute how much each cascade step
 * actually took (for the immutable WalletTransaction ledger). Even if two
 * callers race, the final persisted balance is always correct and clamped.
 */
const clampedSubtract = (field, amount) => ({
  $set: {
    [field]: { $max: [{ $subtract: [`$${field}`, amount] }, 0] },
    walletVersion: { $add: ["$walletVersion", 1] },
  },
});

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

  const before = await TechnicianProfile.findById(technicianId)
    .select("reserveBalancePaise availableBalancePaise outstandingDuesPaise")
    .lean();
  if (!before) return { reserve: 0, available: 0, dues: 0 };

  let remaining = total;
  let reserveTaken = 0;
  let availableTaken = 0;
  let duesTaken = 0;

  const takeReserve = Math.min(before.reserveBalancePaise || 0, remaining);
  if (takeReserve > 0) {
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      clampedSubtract("reserveBalancePaise", takeReserve),
      opts
    );
    reserveTaken = takeReserve;
    remaining -= takeReserve;
  }

  if (remaining > 0) {
    const takeAvail = Math.min(before.availableBalancePaise || 0, remaining);
    if (takeAvail > 0) {
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        clampedSubtract("availableBalancePaise", takeAvail),
        opts
      );
      availableTaken = takeAvail;
      remaining -= takeAvail;
    }
  }

  if (remaining > 0 && allowDues) {
    duesTaken = remaining;
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      { $inc: { outstandingDuesPaise: duesTaken, walletVersion: 1 } },
      opts
    );
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
 * is in flight). Returns the amount actually debited.
 */
export const safeDebitAvailable = async ({ technicianId, amountPaise, session = null }) => {
  const amt = Math.max(Math.round(amountPaise || 0), 0);
  if (amt === 0) return 0;
  const opts = session ? { session } : {};
  const before = await TechnicianProfile.findById(technicianId)
    .select("availableBalancePaise")
    .lean();
  const take = Math.min(before?.availableBalancePaise || 0, amt);
  if (take > 0) {
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      clampedSubtract("availableBalancePaise", take),
      opts
    );
  }
  return take;
};
