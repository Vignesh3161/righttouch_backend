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
import { fetchPayout, PAYOUT_SUCCESS_STATUSES, PAYOUT_FINAL_FAILURE_STATUSES } from "./razorpayX.js";
import { markPaymentSucceeded, markPaymentFailed } from "./paymentTransitions.js";
import { settleEligibleBookingsBackstop } from "./settlement.js";
import { writeAuditLog } from "./audit.js";
import { toPaise, rupeesToPaise, paiseToRupees } from "./money.js";
import { postPayoutLedgerEntry, postLedgerEntry } from "./ledger.js";
import { raiseReconciliationException } from "./paymentTransitions.js";
import { processAutoPayouts } from "./autoPayout.js";
import { releaseFailedWithdrawalReserve } from "./withdrawalPayoutEngine.js";

/**
 * ⏰ PAYMENT RECONCILIATION CRONS
 *
 * No money state may depend on a single HTTP round-trip succeeding:
 *   - Phase 1 (payments): every 15 min — pending payments older than 30 min
 *     are checked against Razorpay; captured → success transition; still
 *     pending after 3 checks → failed + alert.
 *   - Phase 3 (payouts): every 10 min — initiated outbox entries older than
 *     5 min are reconciled against Razorpay X.
 */

const MAX_PAYMENT_RECONCILIATION_ATTEMPTS = 3;
const PAYMENT_RECONCILIATION_AGE_MS = 30 * 60 * 1000; // 30 min
const PAYOUT_RECONCILIATION_AGE_MS = 5 * 60 * 1000;   // 5 min
const MAX_PAYOUT_ATTEMPTS = 5;
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
   PHASE 3 — PAYOUT RECONCILIATION (every 10 min)
===================================================== */

const completePayout = async (outbox, payout) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const withdrawal = await WithdrawalRequest.findById(outbox.withdrawalId).session(session);
      if (!withdrawal) throw new Error("Withdrawal not found for outbox entry");

      const alreadyDebited = await WalletTransaction.findOne(
        { withdrawalId: withdrawal._id, type: "debit", source: "withdraw" },
        null,
        { session }
      );

      const amountPaiseNum = toPaise(withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount));

      withdrawal.status = "paid";
      withdrawal.paidAt = new Date();
      withdrawal.decidedAt = new Date();
      withdrawal.payoutProvider = "razorpay_x";
      withdrawal.payoutReference = outbox.razorpayPayoutId || payout?.id || null;
      withdrawal.adminNote = withdrawal.adminNote || `Paid via Razorpay X reconciliation`;
      await withdrawal.save({ session });

      // Legacy/edge path: if the reserve debit was never recorded
      // (pre-reserve-model requests), deduct + record it now.
      if (!alreadyDebited) {
        await TechnicianProfile.updateOne(
          { _id: withdrawal.technicianId },
          { $inc: { availableBalancePaise: -amountPaiseNum } },
          { session }
        );
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
              note: `Razorpay X payout ${outbox.razorpayPayoutId} (reconciled) – withdrawal #${withdrawal._id}`,
            },
          ],
          { session }
        );
      }

      // Release the reserve + record lifetime withdrawn (reserve model)
      await TechnicianProfile.updateOne(
        { _id: withdrawal.technicianId },
        {
          $inc: {
            reservedBalancePaise: -amountPaiseNum,
            lifetimeWithdrawnPaise: amountPaiseNum,
          },
        },
        { session }
      );

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

const revertPayout = async (outbox, payout, errorMsg) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const withdrawal = await WithdrawalRequest.findById(outbox.withdrawalId).session(session);
      if (!withdrawal) throw new Error("Withdrawal not found for outbox entry");

      if (withdrawal.status === "processing") {
        withdrawal.status = "approved"; // retryable by admin
        withdrawal.decisionNote = `Payout ${payout?.id || outbox.razorpayPayoutId} failed at Razorpay: ${errorMsg}`;
        withdrawal.failedAt = new Date();
        await withdrawal.save({ session });
      }

      outbox.status = "failed";
      outbox.lastError = errorMsg;
      outbox.razorpayPayoutId = outbox.razorpayPayoutId || payout?.id || null;
      outbox.failedAt = new Date();
      await outbox.save({ session });
    });

    await writeAuditLog({
      action: "PAYOUT_RECONCILIATION_FAILED",
      targetType: "WithdrawalRequest",
      targetId: outbox.withdrawalId,
      metadata: { payoutId: payout?.id || null, error: errorMsg },
      reason: "Payout failed at Razorpay; withdrawal reverted to approved for retry",
    });

    console.error(
      `[PayoutCron] ALERT: payout for withdrawal ${outbox.withdrawalId} failed at Razorpay: ${errorMsg}`
    );
  } finally {
    session.endSession();
  }
};

export const reconcileStuckPayouts = async () => {
  const cutoff = new Date(Date.now() - PAYOUT_RECONCILIATION_AGE_MS);

  const stuck = await PayoutOutbox.find({
    status: "initiated",
    updatedAt: { $lt: cutoff },
    attempts: { $lt: MAX_PAYOUT_ATTEMPTS },
  }).limit(50);

  await runBatched(stuck, async (outbox) => {
    try {
      if (!outbox.razorpayPayoutId) {
        // Payout API call itself may have failed before returning an id —
        // treat as failed so admin can retry.
        await revertPayout(outbox, null, "No razorpayPayoutId recorded");
        return;
      }

      const payout = await fetchPayout(outbox.razorpayPayoutId);
      const status = payout?.status;

      if (PAYOUT_SUCCESS_STATUSES.includes(status)) {
        await completePayout(outbox, payout);
      } else if (PAYOUT_FINAL_FAILURE_STATUSES.includes(status)) {
        await revertPayout(outbox, payout, `Razorpay status: ${status}`);
      } else {
        // created / processing / queued — leave for the next run
        await PayoutOutbox.updateOne(
          { _id: outbox._id },
          { $inc: { attempts: 1 } }
        );
      }
    } catch (err) {
      await PayoutOutbox.updateOne(
        { _id: outbox._id },
        { $inc: { attempts: 1 }, $set: { lastError: err.message } }
      );
    }
  });

  // 🔍 Ambiguous payouts parked in `manual_review` (timeout/network at
  // RazorpayX). If we recorded a Razorpay id, we CAN reconcile with the
  // provider; otherwise they stay for an admin to resolve manually.
  const reviewable = await PayoutOutbox.find({
    status: "manual_review",
    razorpayPayoutId: { $exists: true, $ne: null },
    updatedAt: { $lt: cutoff },
    attempts: { $lt: MAX_PAYOUT_ATTEMPTS },
  }).limit(50);

  await runBatched(reviewable, async (outbox) => {
    try {
      const payout = await fetchPayout(outbox.razorpayPayoutId);
      const status = payout?.status;

      if (PAYOUT_SUCCESS_STATUSES.includes(status)) {
        // Money left the platform — complete (release reserve + ledger).
        await completePayout(outbox, payout);
      } else if (PAYOUT_FINAL_FAILURE_STATUSES.includes(status)) {
        // Provider says it failed — refund the held reserve (no double pay).
        const w = await WithdrawalRequest.findById(outbox.withdrawalId).lean();
        if (w) {
          await releaseFailedWithdrawalReserve({
            withdrawalId: outbox.withdrawalId,
            amountPaise: w.amountPaise,
            technicianId: w.technicianId,
            reason: `Razorpay status: ${status}`,
          });
        }
      } else {
        // Still processing at provider — leave for the next run.
        await PayoutOutbox.updateOne(
          { _id: outbox._id },
          { $inc: { attempts: 1 } }
        );
      }
    } catch (err) {
      await PayoutOutbox.updateOne(
        { _id: outbox._id },
        { $inc: { attempts: 1 }, $set: { lastError: err.message } }
      );
    }
  });
};

/**
 * 🛠️ Admin manual resolution of an ambiguous (`manual_review`) payout.
 * `decision` = "complete" (force mark paid — money confirmed sent) or
 * "revert" (refund the held reserve). The platform cannot auto-decide when
 * no Razorpay id was captured, so a human resolves it (spec §6F).
 */
export const adminResolveManualReview = async ({ withdrawalId, decision, admin }) => {
  const withdrawal = await WithdrawalRequest.findById(withdrawalId);
  if (!withdrawal) throw new Error("Withdrawal not found");
  if (withdrawal.status !== "manual_review") {
    throw new Error(`Only manual_review payouts can be resolved here (current: ${withdrawal.status})`);
  }
  const outbox = await PayoutOutbox.findOne({ withdrawalId });

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
  const txnSums = await WalletTransaction.aggregate([
    { $group: { _id: "$technicianId", totalPaise: { $sum: "$amountPaise" } } },
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

  // ── 6. Approved withdrawals idle for > 72h (payout never initiated) ──
  const idleWithdrawals = await WithdrawalRequest.find({
    status: "approved",
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
  const dupPayoutLedger = await PlatformLedgerEntry.aggregate([
    { $match: { type: "technician_payout" } },
    { $group: { _id: "$refs.withdrawalId", count: { $sum: 1 } } },
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

  cron.schedule("*/10 * * * *", async () => {
    if (!dbReady()) return;
    try {
      await reconcileStuckPayouts();
    } catch (err) {
      console.error("[PaymentCron] reconcileStuckPayouts error:", err.message);
    }
  });

  // 💸 Auto-payout cron — every 6 hours (override via AUTO_PAYOUT_CRON_EXPRESSION).
  // Scans high-balance technicians and pays out balance − maintenance floor
  // automatically. Individual payout failures never abort the run, and the
  // 10-min reconcileStuckPayouts above recovers any ambiguous payout.
  cron.schedule(process.env.AUTO_PAYOUT_CRON_EXPRESSION || "0 */6 * * *", async () => {
    if (!dbReady()) return;
    try {
      await processAutoPayouts();
    } catch (err) {
      console.error("[PaymentCron] processAutoPayouts error:", err.message);
    }
  });

  // 🌙 Daily ledger & wallet reconciliation (01:30 IST)
  cron.schedule("30 1 * * *", async () => {
    if (!dbReady()) return;
    try {
      await reconcileDailyLedger();
    } catch (err) {
      console.error("[PaymentCron] reconcileDailyLedger error:", err.message);
    }
  });

  console.log("✅ Payment reconciliation crons are active.");
};
