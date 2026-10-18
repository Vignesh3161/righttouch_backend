import cron from "node-cron";
import mongoose from "mongoose";

import Payment from "../Schemas/Payment.js";
import PayoutOutbox from "../Schemas/PayoutOutbox.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import ReconciliationException from "../Schemas/ReconciliationException.js";

import { fetchOrderPayments } from "./razorpay.js";
import { markPaymentSucceeded, markPaymentFailed } from "./paymentTransitions.js";
import { settleEligibleBookingsBackstop } from "./settlement.js";
import { writeAuditLog } from "./audit.js";
import { toPaise, rupeesToPaise, paiseToRupees } from "./money.js";
import { postPayoutLedgerEntry, postLedgerEntry } from "./ledger.js";
import { raiseReconciliationException } from "./paymentTransitions.js";

/**
 * ⏰ PAYMENT RECONCILIATION CRONS
 *
 * Technician payouts are manual-NEFT-only: an admin transfers via the bank
 * portal and records the UTR with mark-paid. There is no payout-provider
 * integration, so there is no automatic payout reconciliation. Legacy
 * provider-linked records (if any) are resolved by a human via
 * adminResolveManualReview() with verified bank/provider evidence — never
 * automatically.
 *
 *   - Phase 1 (payments): every 15 min — pending payments older than 30 min
 *     are checked against Razorpay; captured → success transition; still
 *     pending after 3 checks → failed + alert.
 *   - Daily ledger (01:30 IST) + manual payout ledger checks (read-only
 *     except ReconciliationException rows and the customer-payment backfill).
 */

const MAX_PAYMENT_RECONCILIATION_ATTEMPTS = 3;
const PAYMENT_RECONCILIATION_AGE_MS = 30 * 60 * 1000; // 30 min
const CRON_CONCURRENCY = 5;

/** 🔌 Skip cron work while Mongo is disconnected (avoids 10s buffer timeouts). */
const dbReady = () => mongoose.connection.readyState === 1;

/**
 * Run an async fn over items with bounded concurrency. Each item's fn must
 * catch its own errors — failures never abort the remaining items.
 */
const runBatched = async (items, fn) => {
  for (let i = 0; i < items.length; i += CRON_CONCURRENCY) {
    await Promise.all(items.slice(i, i + CRON_CONCURRENCY).map(fn));
  }
};

/* =====================================================
   PHASE 1 — PAYMENT RECONCILIATION (every 15 min)
===================================================== */

export const reconcilePendingPayments = async () => {
  const cutoff = new Date(Date.now() - PAYMENT_RECONCILIATION_AGE_MS);

  const pendingPayments = await Payment.find({
    status: "pending",
    providerOrderId: { $ne: null },
    createdAt: { $lt: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  await runBatched(pendingPayments, async (payment) => {
    try {
      const orderPayments = await fetchOrderPayments(payment.providerOrderId);
      const captured = (orderPayments?.items || []).find(
        (p) => p.status === "captured"
      );

      if (captured) {
        const result = await markPaymentSucceeded(payment._id, {
          providerPaymentId: captured.id,
          source: "reconciliation",
        });
        await writeAuditLog({
          action: "PAYMENT_RECONCILIATION_RESOLVED",
          targetType: "Payment",
          targetId: payment._id,
          metadata: {
            providerPaymentId: captured.id,
            alreadyProcessed: result.alreadyProcessed,
          },
        });
      } else {
        await Payment.updateOne(
          { _id: payment._id },
          {
            $inc: { reconciliationAttempts: 1 },
            $set: { lastReconciliationAt: new Date() },
          }
        );
      }
    } catch (err) {
      console.error(`[PaymentCron] Fetch failed for order ${payment.providerOrderId}:`, err.message);

      await Payment.updateOne(
        { _id: payment._id },
        {
          $inc: { reconciliationAttempts: 1 },
          $set: { lastReconciliationAt: new Date() },
        }
      );
    }
  });

  // Exhaust attempts → do NOT blindly fail. A payment is only marked failed
  // after we CONFIRM (fresh live check) that Razorpay never captured it.
  // A mere API/network flake must never freeze a customer's captured money
  // without a refund path (refunds are out of scope by design).
  const exhausted = await Payment.find({
    status: "pending",
    reconciliationAttempts: { $gte: MAX_PAYMENT_RECONCILIATION_ATTEMPTS },
  }).limit(50);

  await runBatched(exhausted, async (payment) => {
    try {
      const orderPayments = await fetchOrderPayments(payment.providerOrderId);
      const captured = (orderPayments?.items || []).find(
        (p) => p.status === "captured"
      );

      if (captured) {
        const result = await markPaymentSucceeded(payment._id, {
          providerPaymentId: captured.id,
          source: "reconciliation",
        });
        await writeAuditLog({
          action: "PAYMENT_RECONCILIATION_RESOLVED",
          targetType: "Payment",
          targetId: payment._id,
          metadata: {
            providerPaymentId: captured.id,
            alreadyProcessed: result.alreadyProcessed,
          },
        });
        return;
      }

      // Live check succeeded AND no captured payment exists — confirmed
      // not captured, safe to fail (still exists for manual rescue via PUT status).
      await markPaymentFailed(payment._id, {
        failureReason: "Reconciliation exhausted - payment not confirmed by Razorpay",
        source: "reconciliation",
      });

      await writeAuditLog({
        action: "PAYMENT_RECONCILIATION_ALERT",
        targetType: "Payment",
        targetId: payment._id,
        metadata: {
          providerOrderId: payment.providerOrderId,
          attempts: payment.reconciliationAttempts,
          bookingId: payment.bookingId,
        },
        reason: "Manual intervention required: verify with Razorpay before re-issuing",
      });

      console.error(
        `[PaymentCron] ALERT: payment ${payment._id} (order ${payment.providerOrderId}) marked failed after live-check confirmed no capture`
      );
    } catch (err) {
      // Live check itself failed (network/API) — DO NOT fail the payment.
      console.error(
        `[PaymentCron] Exhausted but unconfirmed — deferring failure for payment ${payment._id}: ${err.message}`
      );
    }
  });
};

/* =====================================================
   LEGACY PAYOUT RESOLUTION (human-initiated only)
   The automated payout integration was removed. These helpers exist solely
   so an authorized admin can resolve legacy provider-linked records with
   verified bank/provider evidence via adminResolveManualReview() below.
   Nothing here calls a provider or runs on a schedule.
   PayoutOutbox rows are historical evidence; no new rows are ever created.
===================================================== */

export const completePayout = async (outbox, payout) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const withdrawal = await WithdrawalRequest.findById(outbox.withdrawalId).session(session);
      if (!withdrawal) throw new Error("Withdrawal not found for outbox entry");

      // Idempotent: engine may have already marked paid — never double-release
      // the reserve. Just ensure the outbox reflects completion.
      if (withdrawal.status === "paid") {
        outbox.status = "completed";
        outbox.razorpayPayoutId = outbox.razorpayPayoutId || payout?.id || null;
        outbox.payoutPayload = payout || outbox.payoutPayload;
        outbox.completedAt = outbox.completedAt || new Date();
        await outbox.save({ session });
        return;
      }

      const alreadyDebited = await WalletTransaction.findOne(
        { withdrawalId: withdrawal._id, type: "debit", source: "withdraw" },
        null,
        { session }
      );

      // Align with the manual mark-paid settlement: reserve moves by gross requested,
      // lifetime + ledger move by net (after deductions).
      const totalRequestedPaise = toPaise(
        withdrawal.requestedAmountPaise ?? withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount)
      );
      const netPayoutAmountPaise = Math.max(
        0,
        toPaise(
          withdrawal.netPayoutAmountPaise ??
            (totalRequestedPaise -
              toPaise(withdrawal.commissionDeductionPaise || 0) -
              toPaise(withdrawal.penaltyDeductionPaise || 0) -
              toPaise(withdrawal.otherDeductionsPaise || 0))
        )
      );
      const amountPaiseNum = totalRequestedPaise;

      withdrawal.status = "paid";
      withdrawal.paidAt = new Date();
      withdrawal.decidedAt = new Date();
      withdrawal.payoutProvider = "legacy_provider";
      withdrawal.payoutReference = outbox.razorpayPayoutId || payout?.id || null;
      withdrawal.adminNote = withdrawal.adminNote || `Paid via legacy provider payout (human-resolved reconciliation)`;
      withdrawal.requestedAmountPaise = totalRequestedPaise;
      withdrawal.netPayoutAmountPaise = netPayoutAmountPaise;
      withdrawal.amountPaise = netPayoutAmountPaise;
      withdrawal.amount = paiseToRupees(netPayoutAmountPaise);
      await withdrawal.save({ session });

      // Legacy/edge path: if the reserve debit was never recorded
      // (pre-reserve-model requests), establish the hold now (available →
      // reserved) so the release below nets to zero instead of driving
      // reserved negative. H11: clamped to actual available — never negative.
      if (!alreadyDebited) {
        const availDoc = await TechnicianProfile.findById(withdrawal.technicianId)
          .select("availableBalancePaise")
          .session(session)
          .lean();
        const holdPaise = Math.min(toPaise(availDoc?.availableBalancePaise) || 0, amountPaiseNum);
        if (holdPaise < amountPaiseNum) {
          withdrawal.adminNote += ` Reserve-hold shortfall: held ${holdPaise} of ${amountPaiseNum} paise available. Requires human review.`;
        }
        if (holdPaise > 0) {
          await TechnicianProfile.updateOne(
            { _id: withdrawal.technicianId, availableBalancePaise: { $gte: holdPaise } },
            { $inc: { availableBalancePaise: -holdPaise, reservedBalancePaise: holdPaise, walletVersion: 1 } },
            { session }
          );
        }
        try {
          await WalletTransaction.create(
            [
              {
                technicianId: withdrawal.technicianId,
                amountPaise: amountPaiseNum,
                amount: paiseToRupees(amountPaiseNum),
                type: "debit",
                source: "withdraw",
                withdrawalId: withdrawal._id,
                idempotencyKey: `withdrawal:${withdrawal._id}`,
                note: `Legacy provider payout ${outbox.razorpayPayoutId} (human-resolved) – withdrawal #${withdrawal._id}`,
              },
            ],
            { session }
          );
        } catch (e) {
          if (e?.code !== 11000) throw e; // concurrent reconciler won the race
        }
      }

      // Release the reserve (gross) + record lifetime withdrawn (net) —
      // mirrors the manual mark-paid settlement so both paths agree.
      // H11: guarded + clamped — concurrent/retried reconciler cannot drive
      // reserved negative; shortfall is surfaced, not hidden.
      const heldDoc = await TechnicianProfile.findById(withdrawal.technicianId)
        .select("reservedBalancePaise")
        .session(session)
        .lean();
      const releaseHoldPaise = Math.min(toPaise(heldDoc?.reservedBalancePaise) || 0, amountPaiseNum);
      if (releaseHoldPaise > 0) {
        await TechnicianProfile.updateOne(
          { _id: withdrawal.technicianId, reservedBalancePaise: { $gte: releaseHoldPaise } },
          {
            $inc: {
              reservedBalancePaise: -releaseHoldPaise,
              lifetimeWithdrawnPaise: netPayoutAmountPaise,
              walletVersion: 1,
            },
          },
          { session }
        );
      } else {
        await TechnicianProfile.updateOne(
          { _id: withdrawal.technicianId },
          { $inc: { lifetimeWithdrawnPaise: netPayoutAmountPaise, walletVersion: 1 } },
          { session }
        );
        console.warn(`[PayoutCron] withdrawal ${withdrawal._id}: no reserve held, lifetime recorded without reserve release`);
      }

      // 🏦 Platform ledger — real money left the platform
      const ledger = await postPayoutLedgerEntry({
        withdrawal,
        providerReference: outbox.razorpayPayoutId || payout?.id || null,
        session,
      });
      if (!ledger.created) {
        console.warn(`[PayoutCron] ledger entry already posted for withdrawal ${withdrawal._id}`);
      }

      outbox.status = "completed";
      outbox.razorpayPayoutId = outbox.razorpayPayoutId || payout?.id || null;
      outbox.payoutPayload = payout || outbox.payoutPayload;
      outbox.completedAt = new Date();
      await outbox.save({ session });
    });

    await writeAuditLog({
      action: "PAYOUT_RECONCILIATION_COMPLETED",
      targetType: "WithdrawalRequest",
      targetId: outbox.withdrawalId,
      metadata: { payoutId: outbox.razorpayPayoutId },
    });
  } finally {
    session.endSession();
  }
};

/**
 * 🔓 Release a reserve after a legacy payout failure was human-verified, so the
 * technician is never left with their balance frozen and the record reaches a
 * terminal state. Moved here from the removed automated payout engine: it is
 * now called only by adminResolveManualReview() below (human-initiated, with
 * verified bank/provider evidence) — never by a schedule or webhook.
 *
 * Safety: the withdrawal + PayoutOutbox are both marked terminal (`failed`);
 * the wallet reserve is moved back (reserved→available, clamped) with a
 * single compensating refund row.
 */
export const releaseFailedWithdrawalReserve = async ({
  withdrawalId,
  amountPaise,
  technicianId,
  reason = null,
}) => {
  const amt = toPaise(amountPaise);
  const s = await mongoose.startSession();
  try {
    await s.withTransaction(async () => {
      const w = await WithdrawalRequest.findById(withdrawalId).session(s);
      if (!w) return;
      w.status = "failed";
      w.failedAt = new Date();
      w.decisionNote = `Payout failed: ${reason || "unknown"}`;
      w.failureReason = `Payout failed: ${reason || "unknown"}`;

      // Clamped to what is actually held: pre-reserve legacy records hold 0
      // and must not go negative. Shortfalls are noted for human review.
      const heldReserve = await TechnicianProfile.findById(technicianId)
        .select("reservedBalancePaise")
        .session(s)
        .lean();
      const releasePaise = Math.min(toPaise(heldReserve?.reservedBalancePaise) || 0, amt);
      if (releasePaise < amt) {
        w.decisionNote += ` Reserve shortfall: released ${releasePaise} of ${amt} paise held reserve. Requires human review.`;
      }
      await w.save({ session: s });

      await PayoutOutbox.updateOne(
        { withdrawalId },
        { $set: { status: "failed", failedAt: new Date(), lastError: reason || "Payout failed" } },
        { session: s }
      );

      if (releasePaise > 0) {
        await TechnicianProfile.updateOne(
          { _id: technicianId },
          { $inc: { availableBalancePaise: releasePaise, reservedBalancePaise: -releasePaise } },
          { session: s }
        );

        await WalletTransaction.create(
          [
            {
              technicianId,
              amountPaise: releasePaise,
              amount: paiseToRupees(releasePaise),
              type: "credit",
              source: "adjustment",
              withdrawalId,
              idempotencyKey: `withdrawal-refund:${withdrawalId}`,
              note: `Refund for failed withdrawal #${withdrawalId}`,
            },
          ],
          { session: s }
        );
      }
    });
  } catch (e) {
    console.error("releaseFailedWithdrawalReserve error:", e.message);
  } finally {
    s.endSession();
  }
};

/**
 * 🛠️ Admin manual resolution of a legacy `manual_review` payout.
 * `decision` = "complete" (force mark paid — money confirmed sent via bank
 * records) or "revert" (refund the held reserve). A human resolves it with
 * verified evidence; nothing here calls a provider or runs automatically.
 */
export const adminResolveManualReview = async ({ withdrawalId, decision, admin }) => {
  const withdrawal = await WithdrawalRequest.findById(withdrawalId);
  if (!withdrawal) throw new Error("Withdrawal not found");
  if (withdrawal.status !== "manual_review") {
    throw new Error(`Only manual_review payouts can be resolved here (current: ${withdrawal.status})`);
  }
  const outbox = await PayoutOutbox.findOne({ withdrawalId });
  if (!outbox) {
    throw new Error("No linked payout outbox record — resolve via the manual mark-paid/reject flow instead");
  }

  if (decision === "complete") {
    await completePayout(outbox, null);
    await writeAuditLog({
      actor: admin?.userId,
      actorRole: admin?.role || "Admin",
      action: "MANUAL_REVIEW_COMPLETED",
      targetType: "WithdrawalRequest",
      targetId: withdrawalId,
      reason: "Admin force-completed ambiguous payout after provider confirmation",
    });
    return { status: "paid" };
  }

  if (decision === "revert") {
    await releaseFailedWithdrawalReserve({
      withdrawalId,
      amountPaise: withdrawal.amountPaise,
      technicianId: withdrawal.technicianId,
      reason: "Reverted by admin during manual review",
    });
    await writeAuditLog({
      actor: admin?.userId,
      actorRole: admin?.role || "Admin",
      action: "MANUAL_REVIEW_REVERTED",
      targetType: "WithdrawalRequest",
      targetId: withdrawalId,
      reason: "Admin reverted ambiguous payout (refund reserved balance)",
    });
    return { status: "failed" };
  }

  throw new Error("decision must be 'complete' or 'revert'");
};

/* =====================================================
   PHASE 4 — DAILY LEDGER & WALLET RECONCILIATION (section 13)
   Runs every day at 01:30 IST. Every check is idempotent:
   problems surface as ReconciliationException rows (deduped by
   fingerprint) and are NEVER auto-fixed in a destructive way.

   COMPLETE MUTATION INVENTORY (this job WRITES — contrast with the
   read-only Utils/financialReconciliation.js audit, which writes nothing):
   1-2,4,6-8: ReconciliationException inserts only (report-only findings).
   3: customer_payment LEDGER BACKFILL via postLedgerEntry (idempotent key;
      increments summary.fixed) — customer-collection path only.
   5: PayoutOutbox initiated→manual_review flip for >24h stuck rows.
   9: exception rows only (duplicate payout ledgers are never merged/deleted).
   `reconcileManualPayoutLedger` (below): exception rows only.
   NO technician-payout execution, NO reserve moves, NO withdrawal status
   finalization, NO provider transfer calls anywhere in this job.
===================================================== */

export const reconcileDailyLedger = async () => {
  const summary = { checked: 0, exceptions: 0, fixed: 0 };
  const now = new Date();

  // ── 1. Paid bookings that have NO success Payment (money taken, no record) ──
  const orphanPaidBookings = await ServiceBooking.find({
    paymentStatus: "paid",
    paymentId: null,
  })
    .select("_id customerId technicianId totalAmount baseAmount financialSnapshot paidAmountPaise")
    .limit(200)
    .lean();
  summary.checked += orphanPaidBookings.length;
  for (const b of orphanPaidBookings) {
    await raiseReconciliationException({
      code: "PAID_BOOKING_WITHOUT_PAYMENT",
      severity: "critical",
      details: { bookingId: b._id, customerId: b.customerId, technicianId: b.technicianId },
    });
    summary.exceptions++;
  }

  // ── 2. Snapshot integrity: commission + technician === total (paise) ──
  const snapBookings = await ServiceBooking.find({
    "financialSnapshot.totalAmountPaise": { $gt: 0 },
  })
    .select("_id financialSnapshot")
    .limit(200)
    .lean();
  summary.checked += snapBookings.length;
  for (const b of snapBookings) {
    const s = b.financialSnapshot;
    // Invariant (commission.js / money.js assertSplit): commission + technician + gst === total.
    // GST is a pass-through liability, so omitting it here raised a false SNAPSHOT_SPLIT_BROKEN
    // on every GST-bearing booking.
    if (
      toPaise(s.commissionAmountPaise) +
        toPaise(s.technicianAmountPaise) +
        toPaise(s.gstAmountPaise || 0) !==
      toPaise(s.totalAmountPaise)
    ) {
      await raiseReconciliationException({
        code: "SNAPSHOT_SPLIT_BROKEN",
        severity: "critical",
        details: { bookingId: b._id, snapshot: s },
      });
      summary.exceptions++;
    }
  }

  // ── 3. Success payments missing their customer-payment ledger entry ──
  const successPayments = await Payment.find({ status: "success", providerPaymentId: { $ne: null } })
    .select("_id bookingId totalAmountPaise providerPaymentId")
    .limit(200)
    .lean();
  summary.checked += successPayments.length;
  for (const p of successPayments) {
    const exists = await PlatformLedgerEntry.exists({ idempotencyKey: `payment:${p._id}:customer-payment` });
    if (!exists) {
      const ledger = await postLedgerEntry({
        type: "customer_payment",
        direction: "credit",
        amountPaise: toPaise(p.totalAmountPaise),
        idempotencyKey: `payment:${p._id}:customer-payment`,
        refs: { paymentId: p._id, bookingId: p.bookingId },
        providerReference: p.providerPaymentId,
        description: "Daily reconciliation backfill — customer payment capture",
      });
      if (ledger.created) {
        summary.fixed++;
      } else {
        await raiseReconciliationException({
          code: "LEDGER_MISSING_CUSTOMER_PAYMENT",
          severity: "warning",
          details: { paymentId: p._id, bookingId: p.bookingId },
        });
        summary.exceptions++;
      }
    }
  }

  // ── 4. Wallet balances vs wallet-transaction sums (per technician) ──
  // amountPaise is always stored >= 0 — the sign comes from `type`.
  // Summing absolutes flags every technician with both credits and debits,
  // so net credits − debits here (mirrors available = net − reserved).
  const txnSums = await WalletTransaction.aggregate([
    {
      $group: {
        _id: "$technicianId",
        totalPaise: {
          $sum: {
            $cond: [{ $eq: ["$type", "credit"] }, "$amountPaise", { $multiply: ["$amountPaise", -1] }],
          },
        },
      },
    },
    { $limit: 500 },
  ]);
  summary.checked += txnSums.length;
  for (const t of txnSums) {
    if (!t._id) continue;
    const profile = await TechnicianProfile.findById(t._id).select("availableBalancePaise reservedBalancePaise").lean();
    if (!profile) continue;
    const totalPaise = toPaise(t.totalPaise);
    // available = sum(credits − debits) − reserved (reserved is held, not spendable)
    const availableFromTxns = toPaise(totalPaise - toPaise(profile.reservedBalancePaise ?? 0));
    if (availableFromTxns !== toPaise(profile.availableBalancePaise)) {
      await raiseReconciliationException({
        code: "WALLET_BALANCE_MISMATCH",
        severity: "critical",
        details: {
          technicianId: t._id,
          txnSumPaise: totalPaise,
          availablePaise: toPaise(profile.availableBalancePaise),
          reservedPaise: toPaise(profile.reservedBalancePaise),
        },
      });
      summary.exceptions++;
    }
  }

  // ── 5. Outbox stuck in initiated beyond 24h with exhausted attempts → manual_review ──
  const stuckOutbox = await PayoutOutbox.find({
    status: { $in: ["initiated", "manual_review"] },
    updatedAt: { $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
  })
    .select("_id withdrawalId razorpayPayoutId attempts")
    .limit(100)
    .lean();
  summary.checked += stuckOutbox.length;
  for (const o of stuckOutbox) {
    await PayoutOutbox.updateOne({ _id: o._id }, { $set: { status: "manual_review" } });
    await raiseReconciliationException({
      code: "PAYOUT_STUCK_MANUAL_REVIEW",
      severity: "critical",
      details: { outboxId: o._id, withdrawalId: o.withdrawalId, payoutId: o.razorpayPayoutId },
    });
    summary.exceptions++;
  }

  // ── 6. Approved/requested withdrawals idle for > 72h (manual bank run pending) ──
  // Stage 1: `requested` added — both states now wait for the offline run.
  const idleWithdrawals = await WithdrawalRequest.find({
    status: { $in: ["approved", "requested"] },
    decidedAt: { $lt: new Date(now.getTime() - 72 * 60 * 60 * 1000) },
  })
    .select("_id technicianId amountPaise decidedAt")
    .limit(100)
    .lean();
  summary.checked += idleWithdrawals.length;
  for (const w of idleWithdrawals) {
    await raiseReconciliationException({
      code: "WITHDRAWAL_APPROVED_IDLE",
      severity: "warning",
      details: { withdrawalId: w._id, technicianId: w.technicianId, amountPaise: w.amountPaise, decidedAt: w.decidedAt },
    });
    summary.exceptions++;
  }

  // ── 7. manual_review payments unresolved for > 72h ──
  const staleManualPayments = await Payment.find({
    status: "manual_review",
    updatedAt: { $lt: new Date(now.getTime() - 72 * 60 * 60 * 1000) },
  })
    .select("_id bookingId providerPaymentId totalAmountPaise capturedAmountPaise")
    .limit(100)
    .lean();
  summary.checked += staleManualPayments.length;
  for (const p of staleManualPayments) {
    await raiseReconciliationException({
      code: "PAYMENT_MANUAL_REVIEW_STALE",
      severity: "critical",
      details: {
        paymentId: p._id,
        bookingId: p.bookingId,
        providerPaymentId: p.providerPaymentId,
        expectedPaise: p.totalAmountPaise,
        capturedPaise: p.capturedAmountPaise,
      },
    });
    summary.exceptions++;
  }

  // ── 8. Manual-review withdrawals unresolved for > 72h ──
  const staleManualWithdrawals = await WithdrawalRequest.find({
    status: "manual_review",
    updatedAt: { $lt: new Date(now.getTime() - 72 * 60 * 60 * 1000) },
  })
    .select("_id technicianId amountPaise payoutReference")
    .limit(100)
    .lean();
  summary.checked += staleManualWithdrawals.length;
  for (const w of staleManualWithdrawals) {
    await raiseReconciliationException({
      code: "WITHDRAWAL_MANUAL_REVIEW_STALE",
      severity: "critical",
      details: { withdrawalId: w._id, technicianId: w.technicianId, amountPaise: w.amountPaise, payoutReference: w.payoutReference },
    });
    summary.exceptions++;
  }

  // ── 9. Duplicate ledger entries for the same payout (double-spend detection) ──
  // NOTE: PlatformLedgerEntry stores withdrawalId at the TOP LEVEL (see the
  // schema and postLedgerEntry's refs→top-level mapping); there is no `refs`
  // subdocument. Grouping by "$refs.withdrawalId" collapsed every payout
  // entry into _id:null and false-fired once 2+ payouts existed.
  const dupPayoutLedger = await PlatformLedgerEntry.aggregate([
    { $match: { type: "technician_payout", withdrawalId: { $ne: null } } },
    { $group: { _id: "$withdrawalId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 50 },
  ]);
  summary.checked += dupPayoutLedger.length;
  for (const d of dupPayoutLedger) {
    await raiseReconciliationException({
      code: "DUPLICATE_PAYOUT_LEDGER",
      severity: "critical",
      details: { withdrawalId: d._id, entryCount: d.count },
    });
    summary.exceptions++;
  }

  console.log(`[DailyLedger] checked=${summary.checked} exceptions=${summary.exceptions} fixed=${summary.fixed}`);
  return summary;
};

/**
 * Stage 1 manual-flow reconciliation (no provider calls).
 * Called from the daily cron below; every check is read-only except
 * ReconciliationException rows (deduped by fingerprint, never destructive).
 */
export const reconcileManualPayoutLedger = async () => {
  const summary = { checked: 0, exceptions: 0 };

  // ── 10. Paid withdrawals missing their technician_payout ledger entry ──
  const paidWithdrawals = await WithdrawalRequest.find({ status: "paid" })
    .select("_id technicianId amountPaise netPayoutAmountPaise utr paidAt")
    .limit(200)
    .lean();
  summary.checked += paidWithdrawals.length;
  for (const w of paidWithdrawals) {
    const exists = await PlatformLedgerEntry.exists({
      idempotencyKey: `payout:${w._id}:technician-payout`,
    });
    if (!exists) {
      await raiseReconciliationException({
        code: "PAID_WITHOUT_PAYOUT_LEDGER",
        severity: "critical",
        details: { withdrawalId: w._id, technicianId: w.technicianId, utr: w.utr || null },
      });
      summary.exceptions++;
    }
  }

  // ── 11. Duplicate UTRs across withdrawals ──
  const dupUtr = await WithdrawalRequest.aggregate([
    { $match: { utr: { $type: "string", $nin: ["", "N/A"] } } },
    { $group: { _id: "$utr", count: { $sum: 1 }, withdrawals: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 50 },
  ]);
  summary.checked += dupUtr.length;
  for (const d of dupUtr) {
    await raiseReconciliationException({
      code: "DUPLICATE_UTR",
      severity: "critical",
      details: { utr: d._id, count: d.count, withdrawalIds: d.withdrawals },
    });
    summary.exceptions++;
  }

  // ── 12. Reserved balance vs active-withdrawal gross (per technician) ──
  // reservedBalancePaise must equal SUM(gross) of non-terminal withdrawals.
  // Retention reserveBalancePaise is a separate field and is excluded.
  const activeSums = await WithdrawalRequest.aggregate([
    { $match: { status: { $in: ["pending", "requested", "approved", "processing", "manual_review"] } } },
    {
      $group: {
        _id: "$technicianId",
        grossPaise: {
          $sum: {
            $round: {
              $multiply: [
                { $ifNull: ["$requestedAmountPaise", { $ifNull: ["$amountPaise", { $multiply: [{ $ifNull: ["$amount", 0] }, 100] }] }] },
                1,
              ],
            },
          },
        },
        count: { $sum: 1 },
      },
    },
    { $limit: 500 },
  ]);
  summary.checked += activeSums.length;
  for (const a of activeSums) {
    if (!a._id) continue;
    const profile = await TechnicianProfile.findById(a._id)
      .select("reservedBalancePaise")
      .lean();
    if (!profile) continue;
    if (toPaise(profile.reservedBalancePaise) !== toPaise(a.grossPaise)) {
      await raiseReconciliationException({
        code: "RESERVE_MISMATCH",
        severity: "critical",
        details: {
          technicianId: a._id,
          reservedPaise: toPaise(profile.reservedBalancePaise),
          activeGrossPaise: toPaise(a.grossPaise),
          activeCount: a.count,
        },
      });
      summary.exceptions++;
    }
  }

  console.log(`[ManualPayoutLedger] checked=${summary.checked} exceptions=${summary.exceptions}`);
  return summary;
};

/* ================= INIT ================= */

export const initPaymentCrons = () => {
  console.log("⏰ Initializing payment reconciliation crons...");

  cron.schedule("*/15 * * * *", async () => {
    if (!dbReady()) return;
    try {
      await reconcilePendingPayments();
    } catch (err) {
      console.error("[PaymentCron] reconcilePendingPayments error:", err.message);
    }
    // 🚨 Backstop: any booking that is paid + completed but NOT settled gets
    // settled here. This is the guarantee that a technician wallet can never
    // silently stay at ₹0 when the customer paid and the job was completed.
    try {
      const backstop = await settleEligibleBookingsBackstop(100);
      if (backstop.settled > 0) {
        console.log(
          `[PaymentCron] Settlement backstop settled ${backstop.settled}/${backstop.processed} eligible bookings`
        );
      }
    } catch (err) {
      console.error("[PaymentCron] settlement backstop error:", err.message);
    }
  });

  // 💸 Automatic payouts were removed with the RazorpayX integration.
  // Technician payouts are manual-NEFT-only (admin bank transfer + UTR
  // mark-paid). No auto-payout schedule runs here.

  // 🌙 Daily ledger & wallet reconciliation (01:30 IST)
  cron.schedule("30 1 * * *", async () => {
    if (!dbReady()) return;
    try {
      await reconcileDailyLedger();
    } catch (err) {
      console.error("[PaymentCron] reconcileDailyLedger error:", err.message);
    }
    // Stage 1 manual-flow checks (paid-without-ledger, duplicate UTR,
    // reserve-vs-active). Read-only; no provider calls.
    try {
      await reconcileManualPayoutLedger();
    } catch (err) {
      console.error("[PaymentCron] reconcileManualPayoutLedger error:", err.message);
    }
  });

  console.log("✅ Payment reconciliation crons are active.");
};
