import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import Payment from "../Schemas/Payment.js";
import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import { writeAuditLog } from "./audit.js";
import { postLedgerEntry, postPaymentLedgerEntries } from "./ledger.js";
import { toPaise, paiseToRupees } from "./money.js";

/**
 * O2 — Credit technician earnings but FIRST recover any outstanding dues.
 * `recovery` (min(dues, credit)) is pulled from the wallet liability back toward
 * the previously-uncollectable shortfall; the remainder is spendable available.
 * Returns { recovery, credited }.
 */
const creditEarningsRecoverDues = async ({ technicianId, credit, session = null, bookingId = null }) => {
  const opts = session ? { session } : {};
  const tech = await TechnicianProfile.findById(technicianId)
    .select("outstandingDuesPaise")
    .lean();
  const dues = tech?.outstandingDuesPaise || 0;
  const recovery = Math.min(dues, credit);
  const remaining = credit - recovery;

  // H12: floor dues at 0 — a concurrent dues change between the read above
  // and this write must never drive outstandingDuesPaise negative (the
  // schema declares min: 0). The split imprecision on such a race is bounded
  // and reconcilable; negative dues are not.
  await TechnicianProfile.updateOne(
    { _id: technicianId },
    [
      {
        $set: {
          availableBalancePaise: { $add: [{ $ifNull: ["$availableBalancePaise", 0] }, remaining] },
          lifetimeEarnedPaise: { $add: [{ $ifNull: ["$lifetimeEarnedPaise", 0] }, credit] },
          outstandingDuesPaise: {
            $max: [{ $subtract: [{ $ifNull: ["$outstandingDuesPaise", 0] }, recovery] }, 0],
          },
        },
      },
    ],
    opts
  );

  if (recovery > 0) {
    // H11: deterministic idempotency key per booking so retried settlements
    // cannot post duplicate recovery rows. All callers pass bookingId; a
    // missing bookingId skips the row (balance change remains in-txn).
    if (!bookingId) {
      console.warn(`[Settlement] due recovery of ${recovery}paise without bookingId — ledger row skipped`);
      return { recovery, credited: credit };
    }
    const recoveryRow = {
      technicianId,
      bookingId: bookingId || null,
      amountPaise: recovery,
      amount: paiseToRupees(recovery),
      type: "debit",
      source: "penalty",
      idempotencyKey: `due-recovery:${bookingId}`,
      note: "Outstanding penalty/due recovered from job earnings",
    };
    try {
      if (session) {
        await WalletTransaction.create([recoveryRow], opts);
      } else {
        await WalletTransaction.create(recoveryRow);
      }
    } catch (e) {
      if (e?.code !== 11000) throw e; // idempotent — if retried, duplicate key is ignored
    }
  }

  return { recovery, credited: credit };
};

/**
 * 💰 PHASE 2 — SETTLEMENT: internal transfer of the technician's earning from
 * the platform financial position into the technician WALLET LIABILITY.
 *
 * It is NOT an external bank transfer. Real money leaves the platform only at
 * payout (manual-NEFT: admin bank transfer + UTR mark-paid).
 *
 * Conditions (ALL required):
 *   - Booking.paymentStatus === "paid"
 *   - Payment.status === "success"
 *   - Booking.status === "completed"
 *   - Valid, non-deleted technician
 *   - Booking technicianAmountPaise > 0
 *   - Booking financialSnapshot matches Payment snapshot
 *   - No previous successful job settlement exists
 *
 * Idempotency: unique WalletTransaction.idempotencyKey = "job:<bookingId>"
 * (plus the legacy unique (bookingId, credit, job) index). Wallet balance is
 * incremented ONLY for ledger rows this run actually created.
 */

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isTransactionUnsupported = (err) => {
  // H12: match ONLY the genuine standalone-topology error
  // ("Transaction numbers are only allowed on a replica set member or
  // mongos"). The previous broad match on any "Transaction" mention
  // misclassified live-transaction errors such as NoSuchTransaction (code
  // 251, "Transaction with { txnNumber } has been aborted") as fatal
  // topology failures — aborting retries that should have continued.
  // NOTE: sibling copies of this helper exist in paymentTransitions.js /
  // refundEngine.js with the broad pattern (pre-existing; flagged follow-up).
  const msg = String(err?.message || "");
  return (
    msg.includes("replica set member") ||
    (msg.includes("mongos") && msg.includes("Transaction numbers"))
  );
};

const isTransientTxnError = (err) =>
  Array.isArray(err?.errorLabels) && err.errorLabels.includes("TransientTransactionError");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * H12 — bounded transaction runner for settlement writes.
 *
 * The driver's `withTransaction` retries transient errors (e.g. WiredTiger
 * lock-request timeouts under contention) WITHOUT any cap or backoff: two
 * overlapping same-booking settlements can abort each other forever
 * (verified livelock: 1000+ attempts, loser never converges). This runner
 * caps attempts and applies jittered backoff, then surfaces a clean
 * contention failure so the 15-minute backstop (or a later retry) completes
 * the work instead of wedging a worker thread. All effects remain idempotent
 * (unique row/ledger keys), so deferral is always safe.
 *
 * Commit handling: an UnknownTransactionCommitResult retries the COMMIT
 * (never the body); persistently unknown commits throw so we never claim
 * success for uncommitted effects.
 */
const runSettlementTxn = async (session, fn, { maxAttempts = 20 } = {}) => {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await session.startTransaction();
    try {
      const result = await fn();
      try {
        await session.commitTransaction();
      } catch (commitErr) {
        if (
          Array.isArray(commitErr?.errorLabels) &&
          commitErr.errorLabels.includes("UnknownTransactionCommitResult") &&
          attempt < maxAttempts
        ) {
          await sleep(150 * attempt + Math.floor(Math.random() * 250));
          try {
            await session.commitTransaction();
          } catch (retryErr) {
            lastErr = retryErr;
            try {
              await session.abortTransaction();
            } catch {}
            throw retryErr;
          }
        } else {
          throw commitErr;
        }
      }
      return result;
    } catch (e) {
      lastErr = e;
      try {
        await session.abortTransaction();
      } catch {}
      if (isTransientTxnError(e) && attempt < maxAttempts) {
        await sleep(150 * attempt + Math.floor(Math.random() * 250));
        continue;
      }
      throw e;
    }
  }
  const err = new Error(
    `Settlement transaction contention did not clear after ${maxAttempts} attempts — deferring to a later retry`
  );
  err.code = "SETTLEMENT_CONTENTION";
  err.statusCode = 409;
  err.cause = lastErr;
  throw err;
};

const settlementEntries = ({ booking, payment, jobAmountPaise, tipAmountPaise }) => {
  const rows = [
    {
      technicianId: booking.technicianId,
      bookingId: booking._id,
      paymentId: payment?._id || booking.paymentId || null,
      amountPaise: jobAmountPaise,
      amount: null,
      type: "credit",
      source: "job",
      idempotencyKey: `job:${booking._id}`,
      note: "Job earning credited after verified payment",
    },
  ];
  if (tipAmountPaise > 0) {
    rows.push({
      technicianId: booking.technicianId,
      bookingId: booking._id,
      paymentId: payment?._id || booking.paymentId || null,
      amountPaise: tipAmountPaise,
      amount: null,
      type: "credit",
      source: "tip",
      idempotencyKey: `tip:${booking._id}`,
      note: "Customer tip credited to technician (100% pass-through)",
    });
  }
  return rows;
};

/**
 * Pure helper — the authoritative settlement split between job earning and tip.
 * @returns {{jobAmountPaise: number, tipAmountPaise: number, mismatch: boolean}}
 */
export const deriveSettlementSplit = ({ booking, payment }) => {
  const bSnapshot = booking?.financialSnapshot || {};
  // Compare the GROSS snapshot total; `totalAmountPaise` is the net captured
  // after any platform-funded reward discount. Legacy payments have no gross
  // field and fall back to the net total.
  const pTotal = toPaise(payment?.grossTotalAmountPaise || payment?.totalAmountPaise);
  const bTotal = toPaise(bSnapshot.totalAmountPaise ?? booking?.totalAmountPaise);
  const pTech = toPaise(payment?.technicianAmountPaise);
  const pTip = toPaise(payment?.tipAmountPaise);
  const bTech = toPaise(bSnapshot.technicianAmountPaise ?? booking?.technicianAmountPaise);

  const jobAmountPaise = Math.max(toPaise(pTech - pTip), 0);
  const tipAmountPaise = Math.max(toPaise(pTip), 0);

  const mismatch =
    (bTotal !== 0 && pTotal !== 0 && bTotal !== pTotal) ||
    (bTech !== 0 && pTech !== 0 && bTech !== pTech);

  return { jobAmountPaise, tipAmountPaise, mismatch };
};

/**
 * H12 — verify the COMPLETE settlement invariant for a booking, not merely
 * the existence of a settlement record.
 *
 * Complete means ALL of:
 *   1. job credit row `job:<bookingId>` exists with the expected amount;
 *   2. tip credit row `tip:<bookingId>` exists iff a tip is expected;
 *   3. liability ledger entry `settlement:<bookingId>:liability` exists with
 *      the full expected amount (rules out legacy 0-amount duplicate-path
 *      entries — ledger-exists alone does NOT prove the wallet was credited).
 *
 * The wallet balance itself is a derived cache verified by the
 * WALLET_BALANCE_MISMATCH reconciliation, not re-derivable per booking here.
 */
export const verifySettlementComplete = async ({ booking, payment }) => {
  const { jobAmountPaise, tipAmountPaise, mismatch } = deriveSettlementSplit({ booking, payment });
  if (mismatch) return { complete: false, missing: ["snapshot_mismatch"], jobAmountPaise, tipAmountPaise };
  const expectedTotal = toPaise(jobAmountPaise + tipAmountPaise);
  if (expectedTotal <= 0) {
    return { complete: false, missing: ["invalid_technician_amount"], jobAmountPaise, tipAmountPaise };
  }

  const missing = [];
  const jobRow = await WalletTransaction.findOne({ idempotencyKey: `job:${booking._id}` }).lean();
  if (!jobRow || toPaise(jobRow.amountPaise) !== toPaise(jobAmountPaise)) missing.push("job_credit");
  if (tipAmountPaise > 0) {
    const tipRow = await WalletTransaction.findOne({ idempotencyKey: `tip:${booking._id}` }).lean();
    if (!tipRow || toPaise(tipRow.amountPaise) !== toPaise(tipAmountPaise)) missing.push("tip_credit");
  }
  const liability = await PlatformLedgerEntry.findOne({
    idempotencyKey: `settlement:${booking._id}:liability`,
  }).lean();
  if (!liability || toPaise(liability.amountPaise) !== expectedTotal) missing.push("liability_ledger");

  return { complete: missing.length === 0, missing, jobAmountPaise, tipAmountPaise, expectedTotal };
};

const performSettlement = async ({ booking, payment, session = null }) => {
  const techProfile = await TechnicianProfile.findById(booking.technicianId)
    .select("workStatus")
    .lean();
  if (!techProfile) return { settled: false, reason: "technician_not_found" };
  if (techProfile.workStatus === "deleted") {
    return { settled: false, reason: "technician_deleted" };
  }

  const { jobAmountPaise, tipAmountPaise, mismatch } = deriveSettlementSplit({
    booking,
    payment,
  });
  if (mismatch) {
    return {
      settled: false,
      reason: "snapshot_mismatch",
      details: { jobAmountPaise, tipAmountPaise },
    };
  }

  const credited = toPaise(jobAmountPaise + tipAmountPaise);
  if (credited <= 0) {
    return { settled: false, reason: "invalid_technician_amount" };
  }

  const opts = session ? { session } : {};
  const entries = settlementEntries({ booking, payment, jobAmountPaise, tipAmountPaise });

  // 🔁 Standalone-Mongo fallback (no replica set). Wallet is credited ONLY for
  // ledger rows this run actually created (11000 = someone else already did).
  // ⚠️ NOT ATOMIC: without transactions each write commits independently, so
  // a crash between steps can leave partial records (e.g. job credit without
  // the liability ledger row or booking flag). Production MUST run a replica
  // set so the transactional path above is used; this fallback exists only
  // for standalone/dev databases and must never be treated as safe.
  if (!session) {
    console.warn(
      `[Settlement] non-transactional fallback for booking ${booking._id} — replica set required for atomic settlement in production`
    );    let createdJob = false;
    let createdTip = false;
    for (const row of entries) {
      try {
        await WalletTransaction.create(row);
        if (row.source === "job") createdJob = true;
        else if (row.source === "tip") createdTip = true;
      } catch (e) {
        if (e?.code !== 11000) throw e;
      }
    }

    const credit = toPaise((createdJob ? jobAmountPaise : 0) + (createdTip ? tipAmountPaise : 0));
    if (credit > 0) {
      await creditEarningsRecoverDues({ technicianId: booking.technicianId, credit, bookingId: booking._id });
    }

    await postLedgerEntry({
      type: "technician_earning_liability",
      direction: "debit",
      amountPaise: credit,
      idempotencyKey: `settlement:${booking._id}:liability`,
      refs: { bookingId: booking._id, paymentId: payment?._id, technicianId: booking.technicianId },
      description: "Technician earning liability recognized on settlement",
      session: null,
    });

    // H12: NEVER flag settled while effects may be missing. On standalone
    // each write committed independently, so verify the complete invariant
    // before flagging; incomplete results stay unsettled for the backstop and
    // surface via reconciliation instead of masquerading as settled.
    const verification = await verifySettlementComplete({ booking, payment });
    if (!verification.complete) {
      // Dynamic import: paymentTransitions imports this module, so a static
      // import would be circular (existing codebase pattern for such cases).
      const { raiseReconciliationException } = await import("./paymentTransitions.js");
      await raiseReconciliationException({
        code: "SETTLEMENT_INCOMPLETE",
        severity: "critical",
        details: { bookingId: booking._id, missing: verification.missing },
      });
      return {
        settled: false,
        reason: "settlement_incomplete",
        credited,
        jobAmountPaise,
        tipAmountPaise,
      };
    }
    await ServiceBooking.updateOne(
      { _id: booking._id },
      { $set: { settlementStatus: "settled", settledAt: new Date() } }
    );
    return {
      settled: true,
      reason: "settled_non_transactional",
      credited,
      jobAmountPaise,
      tipAmountPaise,
    };
  }

  // 🔒 Transactional path
  let createdJob = false;
  let createdTip = false;
  for (const row of entries) {
    const existing = await WalletTransaction.findOne(
      { idempotencyKey: row.idempotencyKey },
      null,
      opts
    );
    if (existing) {
      if (existing.amountPaise !== row.amountPaise) {
        throw new Error(
          `reconciliation: existing job credit ${existing.amountPaise} !== expected ${row.amountPaise} for booking ${booking._id}`
        );
      }
      // Row already exists → it was already credited by the winning run.
      // Do NOT mark createdJob/createdTip here; only rows created in THIS run
      // may credit (prevents concurrent settlers double-crediting the wallet).
      continue;
    }
    try {
      await WalletTransaction.create([row], opts);
      if (row.source === "job") createdJob = true;
      else if (row.source === "tip") createdTip = true;
    } catch (e) {
      // H12: a duplicate key means a concurrent settler won this row — skip
      // it (its credit belongs to the winning run). Any OTHER error is real
      // and must abort. (The previous inverted logic threw on duplicates and
      // swallowed genuine errors, which deadlocked concurrent settlements.)
      if (e?.code === 11000) continue;
      throw e;
    }
  }

  // Only credit for rows created in THIS run (duplicate → already credited).
  const credit = toPaise((createdJob ? jobAmountPaise : 0) + (createdTip ? tipAmountPaise : 0));
  if (credit > 0) {
    await creditEarningsRecoverDues({ technicianId: booking.technicianId, credit, session, bookingId: booking._id });
  }

  await postLedgerEntry({
    type: "technician_earning_liability",
    direction: "debit",
    amountPaise: credit,
    idempotencyKey: `settlement:${booking._id}:liability`,
    refs: { bookingId: booking._id, paymentId: payment?._id, technicianId: booking.technicianId },
    description: "Technician earning liability recognized on settlement",
    session,
  });

  await ServiceBooking.updateOne(
    { _id: booking._id },
    { $set: { settlementStatus: "settled", settledAt: new Date() } },
    opts
  );

  return {
    settled: true,
    reason: "settled_transactional",
    credited,
    jobAmountPaise,
    tipAmountPaise,
  };
};

/**
 * H12 — repair an incomplete settlement inside ONE transaction.
 *
 * Crash-point analysis (this is the complete matrix):
 *  - no rows persisted (crash before commit / before any write): FRESH —
 *    delegate to performSettlement; atomic on a replica set, idempotent keys
 *    on retry. The wallet credit provably never ran.
 *  - rows partially persisted (job without tip) + ledger missing: the wallet
 *    credit provably never ran either (credit strictly follows ALL rows in
 *    every flow; the transactional path is all-or-nothing). Safe to create
 *    the missing rows and credit the FULL expected total atomically.
 *  - all rows persisted + full liability ledger: the credit provably ran
 *    (ledger posts strictly after credit in every flow). Safe to flag settled.
 *  - all rows persisted + ledger MISSING or mismatched: genuinely AMBIGUOUS
 *    (standalone crash may or may not have credited). NEVER auto-credit and
 *    NEVER flag settled — raise a critical reconciliation exception for a
 *    human with provider/bank evidence.
 *
 * Concurrent repairs serialize on the unique row/ledger keys; only missing
 * pieces are created, and the wallet is credited at most once per outcome
 * above (ambiguous cases credit zero times).
 */
export const repairIncompleteSettlement = async ({ booking, payment, verification = null }) => {
  const check = verification || (await verifySettlementComplete({ booking, payment }));
  if (check.complete) {
    await ServiceBooking.updateOne(
      { _id: booking._id },
      { $set: { settlementStatus: "settled", settledAt: new Date() } }
    );
    // H12: preserve the historical result shape (credited + split) so
    // callers relying on settlement totals keep working.
    return {
      repaired: true,
      reason: "already_complete",
      credited: toPaise(check.jobAmountPaise + check.tipAmountPaise),
      jobAmountPaise: check.jobAmountPaise,
      tipAmountPaise: check.tipAmountPaise,
    };
  }

  const techProfile = await TechnicianProfile.findById(booking.technicianId).select("workStatus").lean();
  if (!techProfile || techProfile.workStatus === "deleted") {
    return { repaired: false, reason: "technician_deleted", missing: check.missing };
  }

  const jobRow = await WalletTransaction.findOne({ idempotencyKey: `job:${booking._id}` }).lean();
  const tipExpected = toPaise(check.tipAmountPaise) > 0;
  const tipRow = tipExpected
    ? await WalletTransaction.findOne({ idempotencyKey: `tip:${booking._id}` }).lean()
    : null;
  const rowsPreExisted = !!jobRow;
  const rowsPartial = !!jobRow && tipExpected && !tipRow;
  const liability = await PlatformLedgerEntry.findOne({
    idempotencyKey: `settlement:${booking._id}:liability`,
  }).lean();
  const ledgerOk =
    !!liability && toPaise(liability.amountPaise) === toPaise(check.jobAmountPaise + check.tipAmountPaise);

  if (ledgerOk) {
    // Ledger-complete but verify() failed only on row amounts — corrupt rows.
    // (verify-complete would have returned true otherwise.)
    const { raiseReconciliationException } = await import("./paymentTransitions.js");
    await raiseReconciliationException({
      code: "SETTLEMENT_ROW_MISMATCH",
      severity: "critical",
      details: { bookingId: booking._id, missing: check.missing },
    });
    return { repaired: false, reason: "settlement_row_mismatch", missing: check.missing };
  }

  if (rowsPreExisted && !rowsPartial) {
    // AMBIGUOUS (see matrix): all rows exist but no valid liability ledger.
    const { raiseReconciliationException } = await import("./paymentTransitions.js");
    await raiseReconciliationException({
      code: "SETTLEMENT_AMBIGUOUS",
      severity: "critical",
      details: { bookingId: booking._id, missing: check.missing },
    });
    return { repaired: false, reason: "settlement_ambiguous", missing: check.missing };
  }

  // Fresh (no rows) or provably-uncredited partial rows: complete atomically.
  const session = await mongoose.startSession();
  try {
    let result = null;
    let freshIneligible = null;
    await runSettlementTxn(session, async () => {
      if (!rowsPreExisted) {
        result = await performSettlement({ booking, payment, session });
        if (!result.settled) {
          // H12: performSettlement reports ineligibility (e.g. zero-amount
          // after a full refund) BEFORE writing anything — surface it as a
          // clean non-repair, not an exception. Nothing was persisted.
          freshIneligible = result;
          return;
        }
        return;
      }
      // Partial: create the missing tip row (amount tripwire), then credit
      // the FULL expected total — the credit provably never ran.
      const entries = settlementEntries({
        booking,
        payment,
        jobAmountPaise: check.jobAmountPaise,
        tipAmountPaise: check.tipAmountPaise,
      });
      for (const row of entries) {
        const existing = await WalletTransaction.findOne({ idempotencyKey: row.idempotencyKey }, null, { session });
        if (existing) {
          if (existing.amountPaise !== row.amountPaise) {
            throw new Error(`reconciliation: existing credit ${existing.amountPaise} !== expected ${row.amountPaise}`);
          }
          continue;
        }
        await WalletTransaction.create([row], { session });
      }
      const credit = toPaise(check.jobAmountPaise + check.tipAmountPaise);
      await creditEarningsRecoverDues({ technicianId: booking.technicianId, credit, session, bookingId: booking._id });
      await postLedgerEntry({
        type: "technician_earning_liability",
        direction: "debit",
        amountPaise: credit,
        idempotencyKey: `settlement:${booking._id}:liability`,
        refs: { bookingId: booking._id, paymentId: payment?._id, technicianId: booking.technicianId },
        description: "Technician earning liability recognized on settlement repair",
        session,
      });
      await ServiceBooking.updateOne(
        { _id: booking._id },
        { $set: { settlementStatus: "settled", settledAt: new Date() } },
        { session }
      );
      result = { settled: true, reason: "repaired_partial", credited: credit };
    });
    if (freshIneligible) {
      return { repaired: false, reason: freshIneligible.reason, missing: check.missing };
    }
    await writeAuditLog({
      action: "SETTLEMENT_REPAIRED",
      targetType: "ServiceBooking",
      targetId: booking._id,
      after: { credited: result?.credited || 0, reason: result?.reason },
      metadata: { source: "settlement_repair", missing: check.missing },
    });
    return {
      repaired: true,
      reason: result?.reason || "repaired",
      credited: result?.credited ?? toPaise(check.jobAmountPaise + check.tipAmountPaise),
      jobAmountPaise: result?.jobAmountPaise ?? check.jobAmountPaise,
      tipAmountPaise: result?.tipAmountPaise ?? check.tipAmountPaise,
    };
  } catch (e) {
    if (isTransactionUnsupported(e)) {
      const { raiseReconciliationException } = await import("./paymentTransitions.js");
      await raiseReconciliationException({
        code: "SETTLEMENT_REPAIR_TXN_REQUIRED",
        severity: "critical",
        details: { bookingId: booking._id, error: e.message },
      });
      return { repaired: false, reason: "repair_txn_required", missing: check.missing };
    }
    if (e?.code === "SETTLEMENT_CONTENTION") {
      // Bounded retries exhausted under live contention: defer (backstop or a
      // later trigger completes it). Never wedge the caller thread.
      return { repaired: false, reason: "settlement_contention", missing: check.missing };
    }
    throw e;
  } finally {
    session.endSession();
  }
};

/**
 * H12 — per-booking in-process serialization gate.
 *
 * Same-process concurrent settlements for one booking are chained so their
 * multi-write transactions never overlap (overlapping txns abort each other
 * via lock-request timeouts faster than infinite driver retries converge —
 * verified livelock). Cross-process overlap remains possible but is safe by
 * construction (idempotent row/ledger keys + bounded retries + clean
 * deferral). The gate never rejects: every waiter eventually runs verify →
 * repair/replay exactly once, in turn.
 */
const pendingSettlements = new Map();

const withBookingGate = async (bookingId, fn) => {
  const key = String(bookingId);
  const prior = pendingSettlements.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  pendingSettlements.set(key, mine);
  try {
    await prior.catch(() => {});
    return await fn();
  } finally {
    if (pendingSettlements.get(key) === mine) pendingSettlements.delete(key);
    release();
  }
};

/**
 * Settlement — idempotent, authoritative-payment-checked, transaction-safe.
 * @returns {Promise<{settled: boolean, reason: string, credited?: number}>}
 */
export const settleBookingEarningsIfEligible = async (bookingId) => {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    return { settled: false, reason: "invalid_bookingId" };
  }

  const booking = await ServiceBooking.findById(bookingId).select(
    "_id settlementStatus paymentStatus status technicianId technicianAmount financialSnapshot paymentId"
  );
  if (!booking) return { settled: false, reason: "booking_not_found" };

  if (booking.settlementStatus === "settled") {
    return { settled: true, reason: "already_settled" };
  }

  const eligible =
    booking.paymentStatus === "paid" &&
    booking.status === "completed" &&
    booking.technicianId &&
    mongoose.Types.ObjectId.isValid(booking.technicianId);

  if (!eligible) {
    if (booking.paymentStatus === "paid" && booking.settlementStatus === "pending") {
      await ServiceBooking.updateOne(
        { _id: booking._id },
        { $set: { settlementStatus: "eligible" } }
      );
    }
    return { settled: false, reason: "not_eligible" };
  }

  // 🔒 Authoritative payment check — never settle unless the Payment doc
  // itself is success.
  let payment = null;
  if (booking.paymentId) {
    payment = await Payment.findById(booking.paymentId).lean();
  }
  if (!payment) {
    payment = await Payment.findOne({ bookingId: booking._id }).lean();
  }
  if (!payment || payment.status !== "success") {
    return { settled: false, reason: "payment_not_success" };
  }

  // Financial snapshot equality guard (Section 8: booking and payment snapshots must match)
  const { mismatch } = deriveSettlementSplit({ booking, payment });
  if (mismatch) {
    return { settled: false, reason: "snapshot_mismatch" };
  }

  // H12 — verify-then-repair serialized per booking (see withBookingGate).
  // Replaces the old existence-only fast path, which marked settled whenever
  // a job row existed even if the wallet credit, tip row, or liability
  // ledger were missing after a crash.
  return withBookingGate(booking._id, async () => {
    const verification = await verifySettlementComplete({ booking, payment });
    if (verification.complete) {
      await ServiceBooking.updateOne(
        { _id: booking._id },
        { $set: { settlementStatus: "settled", settledAt: new Date() } }
      );
      return { settled: true, reason: "already_settled" };
    }
  const repaired = await repairIncompleteSettlement({ booking, payment, verification });
  if (!repaired.repaired) {
    return { settled: false, reason: repaired.reason, details: repaired.missing };
  }
  // H12: preserve the historical result shape (settled/credited/split).
  const result = {
    settled: true,
    reason: repaired.reason,
    credited: repaired.credited,
    jobAmountPaise: repaired.jobAmountPaise,
    tipAmountPaise: repaired.tipAmountPaise,
  };
    // Fresh completions keep the historical SETTLEMENT_COMPLETED audit + reward
    // behavior (repairs already wrote SETTLEMENT_REPAIRED inside repair).
    if (repaired.reason === "settled_transactional") {
      await writeAuditLog({
        action: "SETTLEMENT_COMPLETED",
        targetType: "ServiceBooking",
        targetId: booking._id,
        after: {
          technicianId: booking.technicianId,
          amountPaise: toPaise(verification.jobAmountPaise + verification.tipAmountPaise),
          jobAmountPaise: verification.jobAmountPaise || 0,
          tipAmountPaise: verification.tipAmountPaise || 0,
          paymentId: payment._id,
        },
        metadata: { source: "settlement" },
      });
      // 🪙 Customer rewards (earn-first): best-effort, post-commit only.
      // Fresh settlements only — replays must not re-award (idempotency keys
      // would dedupe anyway). Never throws: reward failure must not undo or
      // block a successful settlement.
      try {
        const { awardServiceReward } = await import("../Services/rewardService.js");
        await awardServiceReward(booking._id);
      } catch (err) {
        console.error(`[Settlement] reward award failed for booking ${booking._id}:`, err.message);
      }
    }
    return result;
  });
};

/**
 * 🚨 BACKSTOP — settle every booking that is paid + completed but not yet
 * settled. Runs every 15 minutes from the payment reconciliation cron.
 */
export const settleEligibleBookingsBackstop = async (limit = 100) => {
  const candidates = await ServiceBooking.find({
    settlementStatus: { $ne: "settled" },
    paymentStatus: "paid",
    status: "completed",
    technicianId: { $ne: null },
  })
    .select("_id")
    .limit(limit);

  let settled = 0;
  for (const booking of candidates) {
    try {
      const result = await settleBookingEarningsIfEligible(booking._id);
      if (result.settled) settled += 1;
    } catch (err) {
      console.error(
        `[SettlementBackstop] failed for booking ${booking._id}: ${err.message}`
      );
    }
  }
  return { processed: candidates.length, settled };
};

export { toMoney };
