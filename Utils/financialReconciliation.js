import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import Payment from "../Schemas/Payment.js";
import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import PayoutOutbox from "../Schemas/PayoutOutbox.js";
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
