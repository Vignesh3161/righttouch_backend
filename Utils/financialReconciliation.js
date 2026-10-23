import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import Payment from "../Schemas/Payment.js";
import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import PayoutOutbox from "../Schemas/PayoutOutbox.js";
import CustomerRewardsWallet from "../Schemas/CustomerRewardsWallet.js";
import RewardLot from "../Schemas/RewardLot.js";
import RewardRedemption from "../Schemas/RewardRedemption.js";
import RewardTransaction from "../Schemas/RewardTransaction.js";
import { deriveSettlementSplit } from "./settlement.js";
import { toPaise, rupeesToPaise } from "./money.js";

/**
 * 📊 READ-ONLY FINANCIAL RECONCILIATION (Stage 4, paginated)
 *
 * Strictly read-only: every operation below is a `.lean()` find /
 * aggregation / `countDocuments` / `exists`. This module NEVER writes (no
 * creates, updates, or deletes — not even ReconciliationException rows),
 * NEVER calls a payment/payout provider, NEVER retries or finalizes
 * anything, and NEVER selects bank details, credentials, or PII beyond
 * operational ids. Safe to run repeatedly: output depends only on database
 * state.
 *
 * COMPLETENESS: document scans use `_id`-ordered keyset pagination
 * (`scanAll`) instead of a single capped `limit()`, so no record is silently
 * omitted on large collections. The report carries `scanned` counts and a
 * `truncated` flag (true when a safety cap stopped a scan or a grouped
 * output hit its cap) — callers must treat `truncated: true` as
 * "re-run with a higher cap", never as "clean".
 *
 * This audit is intentionally SEPARATE from the scheduled jobs in
 * Utils/paymentCrons.js (`reconcileDailyLedger`,
 * `reconcileManualPayoutLedger`), which retain their pre-existing write
 * behavior (exception rows, ledger backfills, outbox triage) for operational
 * compatibility. Do not merge the two: the audit must stay mutation-free
 * while the jobs keep their documented semantics.
 *
 * Canonical rules reused (not reinvented):
 * - settlement eligibility + split: `deriveSettlementSplit()` from
 *   Utils/settlement.js (payment.success + completed + snapshot equality).
 * - reserve policy: reservedBalancePaise == SUM(gross) of active withdrawals
 *   (statuses matching the `uniq_active_payout_per_technician` partial
 *   index). `reserveBalancePaise` (complaint/retention hold) is a SEPARATE
 *   field and is excluded. `availableBalancePaise` is NOT reconstructed:
 *   job/tip/bonus/penalty/adjustment/refund rows all move it, so a full
 *   rebuild is out of scope (stated, not assumed).
 * - withdrawal arithmetic: net == requested − (penalty + commission + other).
 * - manual-paid record: status paid + payoutProvider "manual" + utr +
 *   payoutMode + paidAt + paidBy, with ledger `payout:<id>:technician-payout`.
 * - reward liability: wallet available == EARN + RESTORE - REDEEM - EXPIRE
 *   - REVERSAL, available == sum(lot coinsRemaining), reserved == active
 *   redemption reservations, and a success payment's reward discount equals
 *   its consumed redemption plus the `reward_discount` platform-ledger debit.
 *
 * Result shape: { generatedAt, manualOnly, limit, scanned, truncated,
 * sections, totals } where each finding is { code,
 * severity: "discrepancy"|"needs-investigation", items: [...] } with ids as
 * strings and amounts in integer paise.
 *
 * Production read-only execution (from the repo root, no code changes):
 *   MONGO_URI='<uri>' node --input-type=module -e "
 *     import mongoose from 'mongoose';
 *     import fs from 'node:fs';
 *     import { runFinancialReconciliation } from './Utils/financialReconciliation.js';
 *     await mongoose.connect(process.env.MONGO_URI);
 *     const report = await runFinancialReconciliation({ limit: 20000 });
 *     fs.writeFileSync('reconciliation-report.json', JSON.stringify(report, null, 2));
 *     console.log(JSON.stringify({ ...report.totals, truncated: report.truncated }));
 *     await mongoose.disconnect();"
 * Triage every `discrepancy` and `needs-investigation` item with an
 * authorized human before ANY corrective action. Never auto-repair money.
 */

const ACTIVE_WITHDRAWAL_STATUSES = ["pending", "requested", "approved", "processing", "manual_review"];
const SCAN_BATCH = 1000;
const GROUP_OUTPUT_CAP = 200;

const grossOf = (w) =>
  toPaise(w.requestedAmountPaise ?? w.amountPaise ?? rupeesToPaise(w.amount));

const deductionsOf = (w) =>
  toPaise(w.penaltyDeductionPaise || 0) +
  toPaise(w.commissionDeductionPaise || 0) +
  toPaise(w.otherDeductionsPaise || 0);

const id = (v) => (v == null ? null : String(v));

const section = () => ({ discrepancies: [], needsInvestigation: [] });

/**
 * Keyset-paginated full scan. Never silently omits: sets `truncated` when
 * the safety cap stops the scan (caller must re-run with a higher cap).
 * Filters used with scanAll must not constrain `_id` themselves.
 */
const scanAll = async (model, filter, select, { batch = SCAN_BATCH, cap }) => {
  const docs = [];
  let lastId = null;
  let truncated = false;
  for (;;) {
    const remaining = cap - docs.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const pageFilter = lastId ? { ...filter, _id: { $gt: lastId } } : filter;
    const page = await model
      .find(pageFilter)
      .select(select)
      .sort({ _id: 1 })
      .limit(Math.min(batch, remaining))
      .lean();
    if (!page.length) break;
    docs.push(...page);
    lastId = page[page.length - 1]._id;
    if (page.length < Math.min(batch, remaining)) break; // exhausted
    if (docs.length >= cap) {
      truncated = true;
      break;
    }
  }
  return { docs, scanned: docs.length, truncated };
};

const findInChunks = async (model, ids, select, filter = {}, idField = "_id", batch = SCAN_BATCH) => {
  const docs = [];
  for (let i = 0; i < ids.length; i += batch) {
    const chunk = ids.slice(i, i + batch);
    docs.push(...(await model.find({ ...filter, [idField]: { $in: chunk } }).select(select).lean()));
  }
  return docs;
};

export const runFinancialReconciliation = async ({ limit = 10000 } = {}) => {
  const cap = Math.max(1, Math.min(Number(limit) || 10000, 100000));
  const report = {
    generatedAt: new Date().toISOString(),
    manualOnly: true, // technician payouts are manual-NEFT-only (no provider integration)
    payoutMode: "manual-NEFT-only",
    limit: cap,
    scanned: {},
    truncated: false,
    sections: {
      settlement: section(),
      withdrawals: section(),
      reserves: section(),
      manualPayments: section(),
      outbox: section(),
      rewards: section(),
    },
  };
  const S = report.sections;
  const markTruncated = (t) => {
    if (t) report.truncated = true;
  };

  /* ── A. Earnings settlement ─────────────────────────────────────────── */
  const elig = await scanAll(
    ServiceBooking,
    {
      status: "completed",
      paymentStatus: "paid",
      settlementStatus: { $ne: "settled" },
      technicianId: { $ne: null },
    },
    "_id technicianId paymentId settlementStatus financialSnapshot",
    { cap }
  );
  report.scanned.eligibleUnsettledCandidates = elig.scanned;
  markTruncated(elig.truncated);
  // Batched payment lookup (canonical preference: paymentId, then bookingId).
  const eligPayIds = [...new Set(elig.docs.map((b) => b.paymentId).filter(Boolean))];
  const eligBookingIds = elig.docs.map((b) => b._id);
  const eligPayments = eligBookingIds.length
    ? await Payment.find({
        $or: [{ _id: { $in: eligPayIds } }, { bookingId: { $in: eligBookingIds } }],
      })
        .select("_id bookingId status")
        .lean()
    : [];
  const eligPayById = new Map(eligPayments.map((p) => [String(p._id), p]));
  const eligPayByBooking = new Map(eligPayments.map((p) => [String(p.bookingId), p]));
  const eligibleNoSuccessPayment = [];
  for (const b of elig.docs) {
    const payment =
      (b.paymentId && eligPayById.get(String(b.paymentId))) || eligPayByBooking.get(String(b._id));
    if (payment?.status === "success") {
      S.settlement.discrepancies.push({
        code: "ELIGIBLE_UNSETTLED",
        bookingId: id(b._id),
        technicianId: id(b.technicianId),
        paymentId: id(payment._id),
        settlementStatus: b.settlementStatus,
      });
    } else {
      eligibleNoSuccessPayment.push({
        code: "PAID_BOOKING_WITHOUT_SUCCESS_PAYMENT",
        bookingId: id(b._id),
        technicianId: id(b.technicianId),
        paymentStatus: payment?.status ?? null,
      });
    }
  }
  if (eligibleNoSuccessPayment.length) {
    S.settlement.needsInvestigation.push({
      code: "PAID_BOOKING_WITHOUT_SUCCESS_PAYMENT",
      items: eligibleNoSuccessPayment,
    });
  }

  const settled = await scanAll(
    ServiceBooking,
    { settlementStatus: "settled" },
    "_id technicianId paymentId financialSnapshot",
    { cap }
  );
  report.scanned.settledBookings = settled.scanned;
  markTruncated(settled.truncated);
  const settledIds = settled.docs.map((b) => b._id);
  const settledPayIds = [...new Set(settled.docs.map((b) => b.paymentId).filter(Boolean))];
  const [settledCredits, settledPayments, settledRecoveries] = await Promise.all([
    settledIds.length
      ? WalletTransaction.find({ bookingId: { $in: settledIds }, type: "credit" })
          .select("bookingId source amountPaise")
          .lean()
      : [],
    settledIds.length
      ? Payment.find({
          $or: [{ _id: { $in: settledPayIds } }, { bookingId: { $in: settledIds } }],
        }).lean()
      : [],
    settledIds.length
      ? WalletTransaction.find({
          bookingId: { $in: settledIds },
          type: "debit",
          idempotencyKey: { $regex: "^due-recovery:" },
        })
          .select("bookingId amountPaise idempotencyKey")
          .lean()
      : [],
  ]);
  const creditsByBooking = new Map();
  for (const t of settledCredits) {
    const k = String(t.bookingId);
    if (!creditsByBooking.has(k)) creditsByBooking.set(k, []);
    creditsByBooking.get(k).push(t);
  }
  const settledPayById = new Map(settledPayments.map((p) => [String(p._id), p]));
  const settledPayByBooking = new Map(settledPayments.map((p) => [String(p.bookingId), p]));
  const recoveriesByBooking = new Map();
  for (const r of settledRecoveries) {
    const k = String(r.bookingId);
    if (!recoveriesByBooking.has(k)) recoveriesByBooking.set(k, []);
    recoveriesByBooking.get(k).push(r);
  }
  for (const b of settled.docs) {
    const txns = creditsByBooking.get(String(b._id)) || [];
    const job = txns.find((t) => t.source === "job");
    const tip = txns.find((t) => t.source === "tip");
    const payment =
      (b.paymentId && settledPayById.get(String(b.paymentId))) ||
      settledPayByBooking.get(String(b._id));
    if (!job) {
      S.settlement.discrepancies.push({ code: "SETTLED_MISSING_JOB_CREDIT", bookingId: id(b._id), technicianId: id(b.technicianId) });
      continue;
    }
    if (payment) {
      const { jobAmountPaise, tipAmountPaise, mismatch } = deriveSettlementSplit({ booking: b, payment });
      if (mismatch) {
        S.settlement.needsInvestigation.push({
          code: "SETTLEMENT_SNAPSHOT_MISMATCH",
          items: [{ bookingId: id(b._id), paymentId: id(payment._id) }],
        });
      } else {
        if (toPaise(job.amountPaise) !== toPaise(jobAmountPaise)) {
          S.settlement.discrepancies.push({
            code: "JOB_CREDIT_AMOUNT_MISMATCH",
            bookingId: id(b._id),
            recordedPaise: toPaise(job.amountPaise),
            expectedPaise: toPaise(jobAmountPaise),
          });
        }
        if (toPaise(tipAmountPaise) > 0 && (!tip || toPaise(tip.amountPaise) !== toPaise(tipAmountPaise))) {
          S.settlement.discrepancies.push({
            code: "TIP_CREDIT_AMOUNT_MISMATCH",
            bookingId: id(b._id),
            recordedPaise: tip ? toPaise(tip.amountPaise) : 0,
            expectedPaise: toPaise(tipAmountPaise),
          });
        }
      }
      const credited = toPaise(job?.amountPaise) + toPaise(tip?.amountPaise);
      for (const r of recoveriesByBooking.get(String(b._id)) || []) {
        if (toPaise(r.amountPaise) > credited) {
          S.settlement.discrepancies.push({
            code: "DUE_RECOVERY_EXCEEDS_CREDIT",
            bookingId: id(b._id),
            recoveryPaise: toPaise(r.amountPaise),
            creditedPaise: credited,
          });
        }
      }
    }
  }

  const dupJobCredits = await WalletTransaction.aggregate([
    { $match: { type: "credit", source: "job", bookingId: { $ne: null } } },
    { $group: { _id: "$bookingId", count: { $sum: 1 }, totalPaise: { $sum: "$amountPaise" } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: GROUP_OUTPUT_CAP },
  ]);
  markTruncated(dupJobCredits.length >= GROUP_OUTPUT_CAP);
  for (const d of dupJobCredits) {
    S.settlement.discrepancies.push({
      code: "DUPLICATE_JOB_CREDIT",
      bookingId: id(d._id),
      count: d.count,
      totalPaise: toPaise(d.totalPaise),
    });
  }

  /* ── B. Withdrawals ─────────────────────────────────────────────────── */
  const active = await scanAll(
    WithdrawalRequest,
    { status: { $in: ACTIVE_WITHDRAWAL_STATUSES } },
    "_id technicianId status requestedAmountPaise amountPaise amount",
    { cap }
  );
  report.scanned.activeWithdrawals = active.scanned;
  markTruncated(active.truncated);
  const activeWithdrawals = active.docs;
  const reserveDebitsByWithdrawal = new Map();
  if (activeWithdrawals.length) {
    const debits = await WalletTransaction.find({
      withdrawalId: { $in: activeWithdrawals.map((w) => w._id) },
      type: "debit",
      source: "withdraw",
    })
      .select("withdrawalId amountPaise")
      .lean();
    for (const d of debits) {
      const k = String(d.withdrawalId);
      reserveDebitsByWithdrawal.set(k, (reserveDebitsByWithdrawal.get(k) || 0) + 1);
    }
  }
  const missingReserve = [];
  for (const w of activeWithdrawals) {
    if (!reserveDebitsByWithdrawal.get(String(w._id))) {
      missingReserve.push({
        withdrawalId: id(w._id),
        technicianId: id(w.technicianId),
        status: w.status,
        grossPaise: grossOf(w),
        note: "active withdrawal without a reserve debit (legacy pre-reserve record or missing debit)",
      });
    }
  }
  if (missingReserve.length) S.withdrawals.needsInvestigation.push({ code: "ACTIVE_WITHDRAWAL_MISSING_RESERVE_DEBIT", items: missingReserve });

  const activeByTech = new Map();
  for (const w of activeWithdrawals) {
    const k = String(w.technicianId);
    if (!activeByTech.has(k)) activeByTech.set(k, []);
    activeByTech.get(k).push(w);
  }
  for (const [techId, list] of activeByTech) {
    if (list.length > 1) {
      S.withdrawals.discrepancies.push({
        code: "DUPLICATE_ACTIVE_WITHDRAWALS",
        technicianId: techId,
        count: list.length,
        withdrawalIds: list.map((w) => id(w._id)),
        grossTotalPaise: list.reduce((s, w) => s + grossOf(w), 0),
      });
    }
  }

  const orphanDebits = await WalletTransaction.aggregate([
    { $match: { type: "debit", source: "withdraw", withdrawalId: { $ne: null } } },
    {
      $lookup: {
        from: "withdrawalrequests",
        localField: "withdrawalId",
        foreignField: "_id",
        as: "w",
      },
    },
    { $match: { w: { $size: 0 } } },
    { $project: { withdrawalId: 1, amountPaise: 1, technicianId: 1 } },
    { $limit: GROUP_OUTPUT_CAP },
  ]);
  markTruncated(orphanDebits.length >= GROUP_OUTPUT_CAP);
  for (const d of orphanDebits) {
    S.withdrawals.discrepancies.push({
      code: "ORPHAN_RESERVE_DEBIT",
      withdrawalId: id(d.withdrawalId),
      technicianId: id(d.technicianId),
      amountPaise: toPaise(d.amountPaise),
    });
  }

  const dupRefunds = await WalletTransaction.aggregate([
    { $match: { type: "credit", idempotencyKey: { $regex: "^withdrawal-refund:" } } },
    { $group: { _id: "$withdrawalId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: GROUP_OUTPUT_CAP },
  ]);
  markTruncated(dupRefunds.length >= GROUP_OUTPUT_CAP);
  for (const d of dupRefunds) {
    S.withdrawals.discrepancies.push({ code: "DUPLICATE_RESERVE_RELEASE", withdrawalId: id(d._id), count: d.count });
  }

  const allW = await scanAll(
    WithdrawalRequest,
    {},
    "_id technicianId status requestedAmountPaise amountPaise amount penaltyDeductionPaise commissionDeductionPaise otherDeductionsPaise netPayoutAmountPaise",
    { cap }
  );
  report.scanned.withdrawals = allW.scanned;
  markTruncated(allW.truncated);
  for (const w of allW.docs) {
    const requested = grossOf(w);
    const deductions = deductionsOf(w);
    if (deductions > requested) {
      S.withdrawals.discrepancies.push({
        code: "DEDUCTIONS_EXCEED_REQUESTED",
        withdrawalId: id(w._id),
        requestedPaise: requested,
        deductionsPaise: deductions,
      });
    }
    if (w.netPayoutAmountPaise != null && toPaise(w.netPayoutAmountPaise) !== toPaise(requested - deductions)) {
      S.withdrawals.discrepancies.push({
        code: "NET_AMOUNT_MISMATCH",
        withdrawalId: id(w._id),
        recordedNetPaise: toPaise(w.netPayoutAmountPaise),
        expectedNetPaise: toPaise(requested - deductions),
      });
    }
  }

  /* ── C. Wallet reserves ─────────────────────────────────────────────── */
  const grossByTech = new Map();
  for (const w of activeWithdrawals) {
    const k = String(w.technicianId);
    grossByTech.set(k, (grossByTech.get(k) || 0) + grossOf(w));
  }
  const profilesWithReserve = await TechnicianProfile.find({
    $or: [
      { reservedBalancePaise: { $gt: 0 } },
      { _id: { $in: [...grossByTech.keys()].map((k) => k) } },
    ],
  })
    .select("_id reservedBalancePaise")
    .limit(cap)
    .lean();
  report.scanned.reserveProfiles = profilesWithReserve.length;
  const seenTech = new Set();
  for (const p of profilesWithReserve) {
    seenTech.add(String(p._id));
    const expected = toPaise(grossByTech.get(String(p._id)) || 0);
    if (toPaise(p.reservedBalancePaise) !== expected) {
      S.reserves.discrepancies.push({
        code: "RESERVE_MISMATCH",
        technicianId: id(p._id),
        reservedPaise: toPaise(p.reservedBalancePaise),
        activeGrossPaise: expected,
      });
    }
  }
  for (const [techId, gross] of grossByTech) {
    if (!seenTech.has(techId) && gross > 0) {
      S.reserves.discrepancies.push({
        code: "RESERVE_MISMATCH",
        technicianId: techId,
        reservedPaise: 0,
        activeGrossPaise: toPaise(gross),
        note: "technician profile missing or unreadable with active reserves",
      });
    }
  }

  /* ── D. Manual payment integrity ────────────────────────────────────── */
  const paid = await scanAll(
    WithdrawalRequest,
    { status: "paid" },
    "_id technicianId requestedAmountPaise amountPaise amount penaltyDeductionPaise commissionDeductionPaise otherDeductionsPaise netPayoutAmountPaise utr payoutMode paidAt paidBy payoutProvider",
    { cap }
  );
  report.scanned.paidWithdrawals = paid.scanned;
  markTruncated(paid.truncated);
  const paidWithdrawals = paid.docs;
  const payoutLedgerKeys = paidWithdrawals.map((w) => `payout:${w._id}:technician-payout`);
  const existingPayoutLedgers = new Set(
    payoutLedgerKeys.length
      ? (
          await PlatformLedgerEntry.find({ idempotencyKey: { $in: payoutLedgerKeys } })
            .select("idempotencyKey")
            .lean()
        ).map((e) => e.idempotencyKey)
      : []
  );
  const missingMeta = [];
  for (const w of paidWithdrawals) {
    const missing = [];
    if (!w.utr) missing.push("utr");
    if (!w.payoutMode) missing.push("payoutMode");
    if (!w.paidAt) missing.push("paidAt");
    if (!w.paidBy) missing.push("paidBy");
    if (missing.length) {
      // Legacy provider-paid records carry payoutReference instead of a UTR;
      // they need human review, not an automatic verdict.
      if (w.payoutProvider && w.payoutProvider !== "manual") {
        S.manualPayments.needsInvestigation.push({
          code: "PAID_NON_MANUAL_PROVIDER",
          items: [{ withdrawalId: id(w._id), payoutProvider: w.payoutProvider, missing }],
        });
      } else {
        missingMeta.push({ withdrawalId: id(w._id), technicianId: id(w.technicianId), missing });
      }
    }
    const requested = grossOf(w);
    const expectedNet = toPaise(requested - deductionsOf(w));
    const recordedNet = toPaise(w.netPayoutAmountPaise ?? w.amountPaise);
    if (recordedNet !== expectedNet) {
      S.manualPayments.discrepancies.push({
        code: "PAID_AMOUNT_VS_NET_MISMATCH",
        withdrawalId: id(w._id),
        recordedNetPaise: recordedNet,
        expectedNetPaise: expectedNet,
      });
    }
    if (!existingPayoutLedgers.has(`payout:${w._id}:technician-payout`)) {
      S.manualPayments.discrepancies.push({ code: "PAID_WITHOUT_PAYOUT_LEDGER", withdrawalId: id(w._id) });
    }
  }
  if (missingMeta.length) S.manualPayments.needsInvestigation.push({ code: "PAID_MANUAL_MISSING_METADATA", items: missingMeta });

  const dupUtr = await WithdrawalRequest.aggregate([
    { $match: { utr: { $type: "string", $nin: ["", "N/A"] } } },
    { $group: { _id: "$utr", count: { $sum: 1 }, withdrawalIds: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: GROUP_OUTPUT_CAP },
  ]);
  markTruncated(dupUtr.length >= GROUP_OUTPUT_CAP);
  for (const d of dupUtr) {
    S.manualPayments.discrepancies.push({
      code: "DUPLICATE_UTR",
      utr: d._id,
      count: d.count,
      withdrawalIds: d.withdrawalIds.map((x) => String(x)),
    });
  }

  // Duplicate payout ledger rows for one withdrawal (double-spend evidence).
  // Groups by the canonical top-level withdrawalId (see pre-release fix).
  const dupPayoutLedger = await PlatformLedgerEntry.aggregate([
    { $match: { type: "technician_payout", withdrawalId: { $ne: null } } },
    { $group: { _id: "$withdrawalId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: GROUP_OUTPUT_CAP },
  ]);
  markTruncated(dupPayoutLedger.length >= GROUP_OUTPUT_CAP);
  for (const d of dupPayoutLedger) {
    S.manualPayments.discrepancies.push({
      code: "DUPLICATE_PAYOUT_LEDGER",
      withdrawalId: id(d._id),
      count: d.count,
    });
  }

  const manualWithOutbox = await WithdrawalRequest.aggregate([
    { $match: { status: "paid", payoutProvider: "manual" } },
    {
      $lookup: {
        from: "payoutoutboxes",
        localField: "_id",
        foreignField: "withdrawalId",
        as: "o",
      },
    },
    { $match: { o: { $not: { $size: 0 } } } },
    { $project: { _id: 1 } },
    { $limit: GROUP_OUTPUT_CAP },
  ]);
  markTruncated(manualWithOutbox.length >= GROUP_OUTPUT_CAP);
  if (manualWithOutbox.length) {
    S.manualPayments.needsInvestigation.push({
      code: "MANUAL_PAID_WITH_PROVIDER_OUTBOX",
      items: manualWithOutbox.map((x) => ({ withdrawalId: String(x._id) })),
    });
  }

  const review = await scanAll(
    WithdrawalRequest,
    { status: { $in: ["processing", "manual_review", "failed"] } },
    "_id technicianId status payoutProvider payoutReference updatedAt",
    { cap }
  );
  report.scanned.reviewQueue = review.scanned;
  markTruncated(review.truncated);
  const reviewQueue = review.docs;
  if (reviewQueue.length) {
    S.manualPayments.needsInvestigation.push({
      code: "OPERATOR_REVIEW_QUEUE",
      items: reviewQueue.map((w) => ({
        withdrawalId: id(w._id),
        technicianId: id(w.technicianId),
        status: w.status,
        payoutProvider: w.payoutProvider || null,
      })),
    });
  }
  // Actionable legacy triage: in-flight at the provider with NO linked
  // outbox row. There is nothing to reconcile against automatically — verify
  // the provider/bank dashboard manually. Never assume timeout == failure;
  // never retry or mark paid/failed without verified evidence.
  const inFlight = reviewQueue.filter((w) => ["processing", "manual_review"].includes(w.status));
  if (inFlight.length) {
    const linkedOutbox = new Set(
      (
        await PayoutOutbox.find({ withdrawalId: { $in: inFlight.map((w) => w._id) } })
          .select("withdrawalId")
          .lean()
      ).map((o) => String(o.withdrawalId))
    );
    const stuckNoOutbox = inFlight.filter((w) => !linkedOutbox.has(String(w._id)));
    if (stuckNoOutbox.length) {
      S.outbox.needsInvestigation.push({
        code: "STUCK_IN_FLIGHT_NO_OUTBOX",
        items: stuckNoOutbox.map((w) => ({
          withdrawalId: id(w._id),
          technicianId: id(w.technicianId),
          status: w.status,
          payoutProvider: w.payoutProvider || null,
          payoutReference: w.payoutReference || null,
          runbook: "verify provider/bank dashboard manually; resolve only via resolve-manual-review with evidence",
        })),
      });
    }
  }
  const idle = await scanAll(
    WithdrawalRequest,
    {
      status: { $in: ["approved", "requested"] },
      $or: [{ decidedAt: { $lt: new Date(Date.now() - 72 * 60 * 60 * 1000) } }, { decidedAt: null, createdAt: { $lt: new Date(Date.now() - 72 * 60 * 60 * 1000) } }],
    },
    "_id technicianId status decidedAt createdAt",
    { cap }
  );
  report.scanned.idleAwaiting = idle.scanned;
  markTruncated(idle.truncated);
  if (idle.docs.length) {
    S.manualPayments.needsInvestigation.push({
      code: "IDLE_AWAITING_MANUAL_PAYMENT",
      items: idle.docs.map((w) => ({ withdrawalId: id(w._id), status: w.status })),
    });
  }

  /* ── E. Outbox (read-only view) ─────────────────────────────────────── */
  const open = await scanAll(
    PayoutOutbox,
    { status: { $in: ["initiated", "manual_review"] } },
    "_id withdrawalId status razorpayPayoutId attempts updatedAt",
    { cap }
  );
  report.scanned.openOutbox = open.scanned;
  markTruncated(open.truncated);
  if (open.docs.length) {
    S.outbox.needsInvestigation.push({
      code: "OPEN_PROVIDER_OUTBOX",
      items: open.docs.map((o) => ({
        outboxId: id(o._id),
        withdrawalId: id(o.withdrawalId),
        status: o.status,
        hasProviderId: Boolean(o.razorpayPayoutId),
        attempts: o.attempts ?? 0,
      })),
    });
  }

  /* ── F. Customer rewards (promotional coins, not cash) ─────────────── */
  const [rewardWallets, rewardTxns, rewardLots, redemptions, rewardPayments] = await Promise.all([
    scanAll(
      CustomerRewardsWallet,
      {},
      "customerId availableCoins reservedCoins lifetimeEarnedCoins lifetimeRedeemedCoins lifetimeRestoredCoins lifetimeExpiredCoins lifetimeReversedCoins",
      { cap }
    ),
    scanAll(RewardTransaction, {}, "_id customerId coins type redemptionId idempotencyKey", { cap }),
    scanAll(RewardLot, {}, "customerId coinsRemaining", { cap }),
    scanAll(
      RewardRedemption,
      {},
      "customerId paymentId coinsReserved discountPaise status expiresAt consumedTransactionId",
      { cap }
    ),
    scanAll(
      Payment,
      {
        $or: [
          { rewardDiscountPaise: { $gt: 0 } },
          { rewardCoinsRedeemed: { $gt: 0 } },
          { rewardRedemptionId: { $ne: null } },
        ],
      },
      "_id bookingId itemType status totalAmountPaise grossTotalAmountPaise rewardDiscountPaise rewardCoinsRedeemed rewardRedemptionId",
      { cap }
    ),
  ]);
  report.scanned.rewardWallets = rewardWallets.scanned;
  report.scanned.rewardTransactions = rewardTxns.scanned;
  report.scanned.rewardLots = rewardLots.scanned;
  report.scanned.rewardRedemptions = redemptions.scanned;
  report.scanned.rewardPayments = rewardPayments.scanned;
  for (const part of [rewardWallets, rewardTxns, rewardLots, redemptions, rewardPayments]) {
    markTruncated(part.truncated);
  }

  const walletByCustomer = new Map(rewardWallets.docs.map((w) => [String(w.customerId), w]));
  const txnByCustomer = new Map();
  const redeemByRedemption = new Map();
  for (const t of rewardTxns.docs) {
    const c = String(t.customerId);
    if (!txnByCustomer.has(c)) txnByCustomer.set(c, { EARN: 0, REDEEM: 0, RESTORE: 0, EXPIRE: 0, REVERSAL: 0 });
    const agg = txnByCustomer.get(c);
    if (t.type in agg) agg[t.type] += toPaise(t.coins);
    if (t.type === "REDEEM" && t.redemptionId) {
      redeemByRedemption.set(String(t.redemptionId), t);
    }
  }
  const lotsByCustomer = new Map();
  for (const lot of rewardLots.docs) {
    const c = String(lot.customerId);
    lotsByCustomer.set(c, (lotsByCustomer.get(c) || 0) + toPaise(lot.coinsRemaining));
    if (toPaise(lot.coinsRemaining) < 0) {
      S.rewards.discrepancies.push({ code: "REWARD_LOT_NEGATIVE", lotId: id(lot._id), customerId: c });
    }
  }
  const reservedByCustomer = new Map();
  for (const r of redemptions.docs) {
    if (r.status !== "reserved") continue;
    const c = String(r.customerId);
    reservedByCustomer.set(c, (reservedByCustomer.get(c) || 0) + toPaise(r.coinsReserved));
  }

  const rewardCustomers = new Set([
    ...walletByCustomer.keys(),
    ...txnByCustomer.keys(),
    ...lotsByCustomer.keys(),
    ...reservedByCustomer.keys(),
  ]);
  const negativeFields = [
    "availableCoins",
    "reservedCoins",
    "lifetimeEarnedCoins",
    "lifetimeRedeemedCoins",
    "lifetimeRestoredCoins",
    "lifetimeExpiredCoins",
    "lifetimeReversedCoins",
  ];
  const lifetimeFields = {
    lifetimeEarnedCoins: "EARN",
    lifetimeRedeemedCoins: "REDEEM",
    lifetimeRestoredCoins: "RESTORE",
    lifetimeExpiredCoins: "EXPIRE",
    lifetimeReversedCoins: "REVERSAL",
  };

  for (const customerId of rewardCustomers) {
    const wallet = walletByCustomer.get(customerId);
    const agg = txnByCustomer.get(customerId) || { EARN: 0, REDEEM: 0, RESTORE: 0, EXPIRE: 0, REVERSAL: 0 };
    const expectedAvailable = agg.EARN + agg.RESTORE - agg.REDEEM - agg.EXPIRE - agg.REVERSAL;

    if (!wallet) {
      if (txnByCustomer.has(customerId)) {
        S.rewards.discrepancies.push({ code: "REWARD_TRANSACTIONS_WITHOUT_WALLET", customerId });
      }
      if ((lotsByCustomer.get(customerId) || 0) !== 0) {
        S.rewards.discrepancies.push({
          code: "REWARD_LOTS_WITHOUT_WALLET",
          customerId,
          coinsRemaining: lotsByCustomer.get(customerId) || 0,
        });
      }
      if ((reservedByCustomer.get(customerId) || 0) !== 0) {
        S.rewards.discrepancies.push({
          code: "REWARD_RESERVATION_WITHOUT_WALLET",
          customerId,
          coinsReserved: reservedByCustomer.get(customerId) || 0,
        });
      }
      continue;
    }

    for (const field of negativeFields) {
      if ((Number(wallet[field]) || 0) < 0) {
        S.rewards.discrepancies.push({
          code: "REWARD_WALLET_NEGATIVE",
          customerId,
          field,
          value: wallet[field],
        });
      }
    }

    if (toPaise(wallet.availableCoins) !== expectedAvailable) {
      S.rewards.discrepancies.push({
        code: "REWARD_WALLET_LEDGER_MISMATCH",
        customerId,
        availableCoins: toPaise(wallet.availableCoins),
        expectedAvailableCoins: expectedAvailable,
      });
    }

    const lifetimeMismatch = {};
    for (const [field, type] of Object.entries(lifetimeFields)) {
      if (toPaise(wallet[field]) !== agg[type]) {
        lifetimeMismatch[field] = { actual: toPaise(wallet[field]), expected: agg[type] };
      }
    }
    if (Object.keys(lifetimeMismatch).length) {
      S.rewards.discrepancies.push({ code: "REWARD_WALLET_LIFETIME_MISMATCH", customerId, fields: lifetimeMismatch });
    }

    if ((lotsByCustomer.get(customerId) || 0) !== toPaise(wallet.availableCoins)) {
      S.rewards.discrepancies.push({
        code: "REWARD_LOT_BALANCE_MISMATCH",
        customerId,
        availableCoins: toPaise(wallet.availableCoins),
        lotCoinsRemaining: lotsByCustomer.get(customerId) || 0,
      });
    }

    if ((reservedByCustomer.get(customerId) || 0) !== toPaise(wallet.reservedCoins)) {
      S.rewards.discrepancies.push({
        code: "REWARD_RESERVED_BALANCE_MISMATCH",
        customerId,
        reservedCoins: toPaise(wallet.reservedCoins),
        reservedByRedemptions: reservedByCustomer.get(customerId) || 0,
      });
    }
  }

  const staleCutoff = Date.now() - 60 * 60 * 1000;
  for (const r of redemptions.docs) {
    if (
      r.status === "reserved" &&
      r.expiresAt &&
      new Date(r.expiresAt).getTime() < staleCutoff
    ) {
      S.rewards.needsInvestigation.push({
        code: "REWARD_RESERVATION_STALE",
        redemptionId: id(r._id),
        paymentId: id(r.paymentId),
        customerId: id(r.customerId),
        expiresAt: r.expiresAt,
        coins: toPaise(r.coinsReserved),
      });
    }
  }

  const consumed = redemptions.docs.filter((r) => r.status === "consumed");
  const consumedPaymentIds = [...new Set(consumed.map((r) => r.paymentId).filter(Boolean))];
  const consumedPaymentDocs = await findInChunks(
    Payment,
    consumedPaymentIds,
    "_id bookingId itemType status totalAmountPaise grossTotalAmountPaise rewardDiscountPaise rewardCoinsRedeemed rewardRedemptionId"
  );
  const paymentById = new Map();
  for (const p of [...rewardPayments.docs, ...consumedPaymentDocs]) {
    paymentById.set(String(p._id), p);
  }
  const redemptionByPayment = new Map(
    redemptions.docs.filter((r) => r.paymentId).map((r) => [String(r.paymentId), r])
  );
  const ledgerRows = await findInChunks(
    PlatformLedgerEntry,
    [...paymentById.keys()],
    "paymentId type direction amountPaise",
    { type: "reward_discount" },
    "paymentId"
  );
  const discountLedgerByPayment = new Map(ledgerRows.map((e) => [String(e.paymentId), e]));
  for (const r of consumed) {
    const payment = r.paymentId ? paymentById.get(String(r.paymentId)) : null;
    const item = {
      redemptionId: id(r._id),
      paymentId: id(r.paymentId),
      customerId: id(r.customerId),
      coins: toPaise(r.coinsReserved),
    };
    if (!payment) {
      S.rewards.discrepancies.push({ code: "REWARD_REDEMPTION_PAYMENT_MISSING", ...item });
    } else {
      if (payment.status !== "success") {
        S.rewards.discrepancies.push({
          code: "REWARD_REDEMPTION_PAYMENT_NOT_SUCCESS",
          ...item,
          paymentStatus: payment.status,
        });
      }
      if (toPaise(payment.rewardDiscountPaise) !== toPaise(r.discountPaise)) {
        S.rewards.discrepancies.push({
          code: "REWARD_REDEMPTION_PAYMENT_DISCOUNT_MISMATCH",
          ...item,
          paymentDiscountPaise: toPaise(payment.rewardDiscountPaise),
          redemptionDiscountPaise: toPaise(r.discountPaise),
        });
      }
      if (String(payment.rewardRedemptionId || "") !== String(r._id)) {
        S.rewards.discrepancies.push({
          code: "REWARD_REDEMPTION_PAYMENT_LINK_MISMATCH",
          ...item,
          paymentRedemptionId: id(payment.rewardRedemptionId),
        });
      }
    }
    if (toPaise(r.discountPaise) !== toPaise(r.coinsReserved)) {
      S.rewards.discrepancies.push({
        code: "REWARD_REDEMPTION_COIN_VALUE_MISMATCH",
        ...item,
        discountPaise: toPaise(r.discountPaise),
      });
    }
    const redeemTxn = redeemByRedemption.get(String(r._id));
    if (!redeemTxn) {
      S.rewards.discrepancies.push({ code: "REWARD_REDEMPTION_MISSING_REDEEM_LEDGER", ...item });
    } else if (toPaise(redeemTxn.coins) !== toPaise(r.coinsReserved)) {
      S.rewards.discrepancies.push({
        code: "REWARD_REDEMPTION_LEDGER_AMOUNT_MISMATCH",
        ...item,
        ledgerCoins: toPaise(redeemTxn.coins),
      });
    }
  }

  for (const payment of rewardPayments.docs) {
    const item = {
      bookingId: id(payment.bookingId),
      paymentId: id(payment._id),
      discountPaise: toPaise(payment.rewardDiscountPaise),
    };
    const discountPaise = toPaise(payment.rewardDiscountPaise);
    const gross = toPaise(payment.grossTotalAmountPaise) ||
      toPaise(payment.totalAmountPaise) + discountPaise;
    if (payment.itemType !== "service") {
      S.rewards.discrepancies.push({ code: "REWARD_DISCOUNT_NON_SERVICE_PAYMENT", ...item, itemType: payment.itemType });
    }
    if (gross <= 0 || toPaise(payment.totalAmountPaise) + discountPaise !== gross) {
      S.rewards.discrepancies.push({
        code: "REWARD_PAYMENT_AMOUNT_MISMATCH",
        ...item,
        grossTotalAmountPaise: gross,
        totalAmountPaise: toPaise(payment.totalAmountPaise),
      });
    }
    if (toPaise(payment.rewardCoinsRedeemed) !== discountPaise) {
      S.rewards.discrepancies.push({
        code: "REWARD_PAYMENT_COIN_VALUE_MISMATCH",
        ...item,
        rewardCoinsRedeemed: toPaise(payment.rewardCoinsRedeemed),
      });
    }
    if (payment.status === "success") {
      const redemption = redemptionByPayment.get(String(payment._id));
      if (!redemption) {
        S.rewards.discrepancies.push({ code: "REWARD_DISCOUNT_WITHOUT_REDEMPTION", ...item });
      } else if (redemption.status !== "consumed") {
        S.rewards.discrepancies.push({
          code: "REWARD_DISCOUNT_WITHOUT_CONSUMED_REDEMPTION",
          ...item,
          redemptionId: id(redemption._id),
          redemptionStatus: redemption.status,
        });
      }
      if (discountPaise > 0) {
        const ledger = discountLedgerByPayment.get(String(payment._id));
        if (!ledger) {
          S.rewards.discrepancies.push({ code: "REWARD_DISCOUNT_MISSING_LEDGER", ...item });
        } else if (toPaise(ledger.amountPaise) !== discountPaise || ledger.direction !== "debit") {
          S.rewards.discrepancies.push({
            code: "REWARD_DISCOUNT_LEDGER_MISMATCH",
            ...item,
            ledgerAmountPaise: toPaise(ledger.amountPaise),
            ledgerDirection: ledger.direction,
          });
        }
      }
    }
  }

  const countItems = (list) => list.reduce((s, f) => s + (f.items ? f.items.length : 1), 0);
  const totals = { discrepancies: 0, needsInvestigation: 0 };
  for (const sec of Object.values(S)) {
    totals.discrepancies += countItems(sec.discrepancies);
    totals.needsInvestigation += countItems(sec.needsInvestigation);
  }
  report.totals = totals;
  return report;
};

export const isReconciliationReadOnly = true;
