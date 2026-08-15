import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import Payment from "../Schemas/Payment.js";
import { writeAuditLog } from "./audit.js";
import { postLedgerEntry, postPaymentLedgerEntries } from "./ledger.js";
import { toPaise } from "./money.js";

/**
 * 💰 PHASE 2 — SETTLEMENT: internal transfer of the technician's earning from
 * the platform financial position into the technician WALLET LIABILITY.
 *
 * It is NOT an external bank transfer. Real money leaves the platform only at
 * payout (Phase 5, RazorpayX).
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
  const msg = String(err?.message || "");
  return (
    msg.includes("replica set") ||
    msg.includes("Transaction") ||
    msg.includes("mongos")
  );
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
  const pTotal = toPaise(payment?.totalAmountPaise);
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
  if (!session) {
    let createdJob = false;
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
      await TechnicianProfile.updateOne(
        { _id: booking.technicianId },
        {
          $inc: { availableBalancePaise: credit, lifetimeEarnedPaise: credit },
        }
      );
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
      if (row.source === "job") createdJob = true; // already credited — fast path below handles
      continue;
    }
    try {
      await WalletTransaction.create([row], opts);
      if (row.source === "job") createdJob = true;
      else if (row.source === "tip") createdTip = true;
    } catch (e) {
      if (e?.code === 11000) continue;
      throw e;
    }
  }

  // Only credit for rows created in THIS run (duplicate → already credited).
  const credit = toPaise((createdJob ? jobAmountPaise : 0) + (createdTip ? tipAmountPaise : 0));
  if (credit > 0) {
    await TechnicianProfile.updateOne(
      { _id: booking.technicianId },
      {
        $inc: { availableBalancePaise: credit, lifetimeEarnedPaise: credit },
      },
      opts
    );
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

  // 🚀 FAST PATH — ledger already has the job credit → mark settled.
  const alreadyJobCredit = await WalletTransaction.findOne({
    idempotencyKey: `job:${booking._id}`,
  }).lean();
  if (alreadyJobCredit) {
    await ServiceBooking.updateOne(
      { _id: booking._id },
      { $set: { settlementStatus: "settled", settledAt: new Date() } }
    );
    return { settled: true, reason: "already_settled" };
  }

  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const fresh = await ServiceBooking.findById(booking._id)
        .select("settlementStatus")
        .session(session);
      if (fresh?.settlementStatus === "settled") {
        return { settled: true, reason: "already_settled" };
      }
      return await performSettlement({ booking, payment, session });
    });
    await writeAuditLog({
      action: "SETTLEMENT_COMPLETED",
      targetType: "ServiceBooking",
      targetId: booking._id,
      after: {
        technicianId: booking.technicianId,
        amountPaise: result.credited || 0,
        jobAmountPaise: result.jobAmountPaise || 0,
        tipAmountPaise: result.tipAmountPaise || 0,
        paymentId: payment._id,
      },
      metadata: { source: "settlement" },
    });
    return result;
  } catch (e) {
    if (isTransactionUnsupported(e)) {
      return await performSettlement({ booking, payment, session: null });
    }
    throw e;
  } finally {
    session.endSession();
  }
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
