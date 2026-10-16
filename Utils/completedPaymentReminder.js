/**
 * 💳 COMPLETED-BUT-UNPAID BOOKING REMINDER & ESCALATION
 *
 * A booking may be marked `completed` while the customer payment is still
 * pending. Settlement correctly refuses to credit the technician wallet
 * before verified payment — this worker provides the operational follow-up
 * so such bookings don't sit eligible-but-unpaid indefinitely.
 *
 * What it does (and ONLY this):
 *   1. Finds completed + unpaid bookings past a configurable age.
 *   2. Sends a customer payment reminder via `sendAppNotification`
 *      (persistent Notification + socket + FCM push — the existing layers).
 *   3. Escalates long-overdue bookings to the admin dashboard room.
 *   4. Records per-stage timestamps atomically; overlapping workers can
 *      never double-send. Failed sends leave the timestamp unset so the
 *      next sweep retries.
 *
 * What it NEVER does (financial invariants):
 *   - credit a wallet, post a ledger entry, mark a payment successful,
 *     change a booking to paid, cancel a booking, or trigger a payout.
 * Only the verified settlement flow (`Utils/settlement.js`) moves money.
 *
 * Eligibility is re-checked against the AUTHORITATIVE Payment record —
 * never inferred from booking flags alone. Ambiguous payments
 * (`manual_review`), active disputes, and in-flight refunds all suppress
 * reminders.
 */
import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import Payment from "../Schemas/Payment.js";
import Report from "../Schemas/Report.js";
import Refund from "../Schemas/Refund.js";
import { sendAppNotification } from "../Services/unifiedNotificationService.js";
import { getIo } from "./ioAccess.js";
import { SOCKET_ROOMS } from "./socketConstants.js";
import { writeAuditLog } from "./audit.js";

// ── Policy (env-overridable, conservative defaults) ──────────────────────
// No payment deadline is imposed — these are reminder/escalation ages only.
const hours = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const PAYMENT_REMINDER_POLICY = {
  // First customer reminder: 24h after completion.
  firstAfterHours: hours(process.env.PAYMENT_REMINDER_FIRST_HOURS, 24),
  // Second customer reminder: 72h after completion.
  secondAfterHours: hours(process.env.PAYMENT_REMINDER_SECOND_HOURS, 72),
  // Admin escalation: 7d after completion.
  escalateAfterHours: hours(process.env.PAYMENT_REMINDER_ESCALATE_HOURS, 168),
  // Max bookings processed per stage per sweep (bounded cron work).
  batchLimit: hours(process.env.PAYMENT_REMINDER_BATCH_LIMIT, 100),
};

export const PAYMENT_REMINDER_STAGES = ["first", "second", "escalated"];
const STAGE_FIELD = { first: "firstAt", second: "secondAt", escalated: "escalatedAt" };

// Booking states that take a booking OUT of the reminder flow.
const OPEN_DISPUTE_STATUSES = ["open", "under_review"];
// Payment states that suppress reminders (authoritative record wins).
const SUPPRESS_PAYMENT_STATUSES = ["success", "manual_review", "refunded"];

/**
 * Authoritative unpaid check. Returns { unpaid, reason }.
 * `unpaid=false` means "do NOT remind" (paid / ambiguous / resolved).
 */
export const checkAuthoritativeUnpaid = async (booking) => {
  let payment = null;
  if (booking.paymentId) {
    payment = await Payment.findById(booking.paymentId)
      .select("status bookingId")
      .lean();
  }
  if (!payment) {
    payment = await Payment.findOne({ bookingId: booking._id })
      .select("status bookingId")
      .lean();
  }
  // No payment record yet → genuinely unpaid (customer hasn't paid).
  if (!payment) return { unpaid: true, reason: "no_payment_record", payment: null };
  if (SUPPRESS_PAYMENT_STATUSES.includes(payment.status)) {
    return { unpaid: false, reason: `payment_${payment.status}`, payment };
  }
  // pending / failed → unpaid (failed means the attempt didn't capture).
  return { unpaid: true, reason: `payment_${payment.status}`, payment };
};

/** Active dispute or in-flight refund suppresses reminders. */
export const checkExcludedByDisputeOrRefund = async (bookingId) => {
  const dispute = await Report.findOne({
    bookingId,
    status: { $in: OPEN_DISPUTE_STATUSES },
  })
    .select("_id status")
    .lean();
  if (dispute) return { excluded: true, reason: `dispute_${dispute.status}` };
  const refund = await Refund.findOne({ bookingId }).select("_id status").lean();
  if (refund) return { excluded: true, reason: `refund_${refund.status}` };
  return { excluded: false, reason: null };
};

/**
 * Find candidate bookings for one reminder stage. Candidates still need the
 * authoritative + dispute checks (cheap, per-booking) before claiming.
 */
export const findPaymentReminderCandidates = async (stage, now = new Date(), limit = PAYMENT_REMINDER_POLICY.batchLimit, { priorTo = null } = {}) => {
  const field = STAGE_FIELD[stage];
  if (!field) throw new Error(`Unknown payment-reminder stage: ${stage}`);
  const ageHours =
    stage === "first"
      ? PAYMENT_REMINDER_POLICY.firstAfterHours
      : stage === "second"
        ? PAYMENT_REMINDER_POLICY.secondAfterHours
        : PAYMENT_REMINDER_POLICY.escalateAfterHours;
  const cutoff = new Date(now.getTime() - ageHours * 60 * 60 * 1000);
  const query = {
    status: "completed",
    paymentStatus: "pending",
    settlementStatus: { $ne: "settled" },
    cancellationStatus: "active",
    completedAt: { $lte: cutoff },
    [`paymentReminders.${field}`]: null,
  };
  // Later stages require the previous stage to have been sent in an EARLIER
  // sweep — a long-overdue booking catches up gradually (one stage per
  // sweep) instead of bursting all reminders at once.
  if (stage === "second") {
    query["paymentReminders.firstAt"] = { $ne: null };
    if (priorTo) query["paymentReminders.firstAt"].$lt = priorTo;
  } else if (stage === "escalated") {
    query["paymentReminders.secondAt"] = { $ne: null };
    if (priorTo) query["paymentReminders.secondAt"].$lt = priorTo;
  }
  return ServiceBooking.find(query)
    .select("_id customerId completedAt paymentId paymentStatus settlementStatus paymentReminders")
    .limit(limit)
    .lean();
};

/**
 * 🔒 ATOMIC STAGE CLAIM — only one worker wins per booking+stage.
 * The claim also re-asserts booking-level eligibility in the filter, so a
 * booking that became paid/settled between scan and claim cannot be claimed.
 * Returns the claimed doc, or null when already claimed / ineligible.
 */
export const claimPaymentReminderStage = async (bookingId, stage, now = new Date()) => {
  const field = STAGE_FIELD[stage];
  if (!field) throw new Error(`Unknown payment-reminder stage: ${stage}`);
  return ServiceBooking.findOneAndUpdate(
    {
      _id: bookingId,
      status: "completed",
      paymentStatus: "pending",
      settlementStatus: { $ne: "settled" },
      cancellationStatus: "active",
      [`paymentReminders.${field}`]: null,
    },
    {
      $set: { [`paymentReminders.${field}`]: now, "paymentReminders.lastAttemptAt": now },
      $inc: { "paymentReminders.attempts": 1 },
    },
    { new: true }
  );
};

/** Release a claim so a later sweep retries (send failed transiently). */
export const releasePaymentReminderClaim = async (bookingId, stage) => {
  const field = STAGE_FIELD[stage];
  await ServiceBooking.updateOne(
    { _id: bookingId },
    { $set: { [`paymentReminders.${field}`]: null } }
  );
};

// ── Delivery (injectable for tests) ──────────────────────────────────────
const defaultCustomerNotifier = async ({ booking, stage, io }) => {
  const copy =
    stage === "first"
      ? {
          title: "💳 Payment Due",
          message: `Your service is complete. Please complete your payment of booking ${booking._id} at your convenience.`,
        }
      : {
          title: "⏰ Payment Reminder",
          message: `A gentle reminder: payment for your completed service (booking ${booking._id}) is still pending.`,
        };
  return sendAppNotification({
    userId: booking.customerId?.toString?.() || booking.customerId,
    recipientType: "customer",
    type: "PAYMENT_DUE",
    title: copy.title,
    message: copy.message,
    bookingId: booking._id,
    metadata: { socketEvent: "payment:status", reminderStage: stage },
    priority: "high",
    category: "payment",
    io: io || getIo(),
  });
};

const defaultAdminEscalation = async ({ booking, io }) => {
  const socketServer = io || getIo();
  const payload = {
    bookingId: String(booking._id),
    customerId: booking.customerId ? String(booking.customerId) : null,
    completedAt: booking.completedAt,
    paymentStatus: booking.paymentStatus,
    message: `Booking ${booking._id} completed ${PAYMENT_REMINDER_POLICY.escalateAfterHours}h+ ago with no payment.`,
    timestamp: new Date().toISOString(),
  };
  socketServer?.to(SOCKET_ROOMS.ADMIN_DASHBOARD).emit("booking:payment_overdue", payload);
  await writeAuditLog({
    actorRole: "System",
    action: "COMPLETED_UNPAID_ESCALATED",
    targetType: "ServiceBooking",
    targetId: booking._id,
    after: { completedAt: booking.completedAt, paymentStatus: booking.paymentStatus },
    metadata: { source: "completedPaymentReminder" },
  });
  return { success: true };
};

/**
 * Process ONE booking for ONE stage: authoritative checks → claim → send.
 * Returns a result object; never throws for per-booking conditions (throws
 * only on unexpected DB errors, which the sweep catches per booking).
 */
export const processPaymentReminder = async (
  bookingId,
  stage,
  { now = new Date(), io = null, customerNotifier = defaultCustomerNotifier, adminEscalation = defaultAdminEscalation } = {}
) => {
  const booking = await ServiceBooking.findById(bookingId)
    .select("_id customerId completedAt paymentId paymentStatus settlementStatus cancellationStatus status paymentReminders")
    .lean();
  if (!booking) return { status: "skipped", reason: "booking_not_found" };
  if (booking.status !== "completed" || booking.paymentStatus !== "pending") {
    return { status: "skipped", reason: "not_completed_unpaid" };
  }
  if (booking.settlementStatus === "settled") return { status: "skipped", reason: "already_settled" };
  if (booking.cancellationStatus !== "active") return { status: "skipped", reason: "not_active" };

  // Authoritative payment record wins over booking flags.
  const auth = await checkAuthoritativeUnpaid(booking);
  if (!auth.unpaid) return { status: "skipped", reason: auth.reason };

  const excl = await checkExcludedByDisputeOrRefund(booking._id);
  if (excl.excluded) return { status: "skipped", reason: excl.reason };

  // Atomic claim — losers (repeat or concurrent runs) stop here.
  const claimed = await claimPaymentReminderStage(booking._id, stage, now);
  if (!claimed) return { status: "skipped", reason: "already_claimed" };

  try {
    if (stage === "escalated") {
      await adminEscalation({ booking: claimed, io });
    } else {
      if (!claimed.customerId) {
        await releasePaymentReminderClaim(booking._id, stage);
        return { status: "skipped", reason: "missing_customer" };
      }
      const res = await customerNotifier({ booking: claimed, stage, io });
      if (!res || res.success === false) throw new Error(res?.reason || res?.error || "notifier_failed");
    }
    return { status: "sent", stage, bookingId: String(booking._id) };
  } catch (err) {
    // Transient failure: release the claim so the next sweep retries.
    // `attempts`/`lastAttemptAt` stay recorded for monitoring.
    await releasePaymentReminderClaim(booking._id, stage);
    return { status: "retry", reason: err.message };
  }
};

/**
 * Run one full sweep across all stages. Bounded, overlap-safe, read-only
 * except for the reminder timestamps it claims. Returns stage summaries.
 */
export const runPaymentReminderSweep = async ({ now = new Date(), io = null, customerNotifier, adminEscalation, limit } = {}) => {
  if (mongoose.connection.readyState !== 1) return { skipped: "db_not_ready" };
  const sweepStart = now;
  const summary = {};
  for (const stage of PAYMENT_REMINDER_STAGES) {
    const candidates = await findPaymentReminderCandidates(stage, now, limit, { priorTo: sweepStart });
    const stageSummary = { candidates: candidates.length, sent: 0, skipped: 0, retry: 0 };
    for (const c of candidates) {
      try {
        const r = await processPaymentReminder(c._id, stage, { now, io, customerNotifier, adminEscalation });
        if (r.status === "sent") stageSummary.sent += 1;
        else if (r.status === "retry") stageSummary.retry += 1;
        else stageSummary.skipped += 1;
      } catch (err) {
        stageSummary.retry += 1;
        console.error(`[PaymentReminder:${stage}] booking ${c._id}:`, err.message);
      }
    }
    summary[stage] = stageSummary;
  }
  return summary;
};
