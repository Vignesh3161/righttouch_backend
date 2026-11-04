/**
 * ✅ SERVICE COMPLETION VERIFICATION (Checkpoint C).
 *
 * Customer-confirmed job completion: the technician requests completion,
 * the customer receives a payment-due notification, pays online, and only
 * then receives the 4-digit OTP by SMS. The technician submits the OTP and
 * the booking flips to `completed` ONLY inside the same transaction that
 * consumes the challenge.
 *
 * Boundaries (deliberate):
 *  - This service moves NO money. After commit, the caller runs the
 *    EXISTING completion side effects (settleBookingEarningsIfEligible +
 *    notifications).
 *  - Attempt counting happens OUTSIDE the transaction (one HTTP attempt =
 *    one count); transaction retries only wrap consume+flip, so a retry
 *    can never double-count an incorrect attempt.
 *  - SMS is sent only AFTER payment succeeds (provider calls never run
 *    inside a MongoDB transaction). Crash gap documented in
 *    Utils/sendCompletionSms.js; resend re-drives delivery.
 */
import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import ServiceCompletionChallenge from "../Schemas/ServiceCompletionChallenge.js";
import Payment from "../Schemas/Payment.js";
import User from "../Schemas/User.js";
import Report from "../Schemas/Report.js";
import { canTransition, normalizeBookingStatus } from "../Utils/bookingStatus.js";
import {
  OTP_PATTERN,
  OTP_TTL_MS,
  OTP_MAX_RESENDS,
  OTP_ERRORS,
  otpError,
  getCompletionOtpPepper,
  generateCompletionOtp,
  hashCompletionOtp,
  verifyCompletionOtpHash,
  isChallengeExpired,
  recordCompletionAttempt,
  registerCompletionResend,
  rollbackCompletionResend,
  prepareCompletionChallengeDelivery,
  markChallengeDelivering,
  consumeCompletionChallenge,
  closeCompletionChallenge,
  closeActiveChallengesForBooking,
} from "../Utils/completionOtp.js";
import { sendCompletionSms, validateCompletionSmsConfig } from "../Utils/sendCompletionSms.js";
import { writeAuditLog } from "../Utils/audit.js";
import { checkTechnicianActivation } from "../Utils/technicianActivation.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { isSuccessfulServicePayment } from "../Utils/servicePaymentEligibility.js";
import { sendAppNotification } from "./unifiedNotificationService.js";
import { SOCKET_EVENTS } from "../Utils/socketConstants.js";

const fail = (statusCode, code, message) => {
  const err = otpError(code, message);
  err.statusCode = statusCode;
  return err;
};

const toId = (v) => (v == null ? null : String(v));

const sendCooldownMs = () => {
  const raw = Number(process.env.COMPLETION_OTP_SEND_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
};

const completionGraceMs = () => {
  const raw = Number(process.env.COMPLETION_OTP_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25 * 60_000;
};

/**
 * Milliseconds left before another provider send is allowed for this
 * challenge. Initial sends and resends both stamp `lastSentAt`, so rapid
 * client retries cannot turn into a Fast2SMS spam burst (provider error 995).
 */
export const completionOtpCooldownRemainingMs = (challenge, now = new Date()) => {
  if (!challenge) return 0;
  const lastSentAt = challenge.lastSentAt || challenge.createdAt;
  if (!lastSentAt) return 0;
  const elapsed = now.getTime() - new Date(lastSentAt).getTime();
  return Math.max(0, sendCooldownMs() - elapsed);
};

const rateLimited = (remainingMs) => {
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const err = fail(
    429,
    OTP_ERRORS.RATE_LIMITED,
    `Please wait ${retryAfterSeconds}s before requesting another OTP`
  );
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
};

const isValidDeliveryPhone = (phone) =>
  /^[0-9]{10}$/.test(phone) || (phone.length === 12 && phone.startsWith("91"));

const loadCustomerPhone = async (customerId) => {
  const customer = await User.findById(customerId).select("mobileNumber").lean();
  return String(customer?.mobileNumber || "").replace(/\D/g, "");
};

const isFreeServicePayment = (payment) => {
  if (!payment) return false;
  if (String(payment.provider || "").toLowerCase() === "free") return true;
  return Number(payment.totalAmountPaise || 0) === 0;
};

/**
 * A paid service booking only counts when there is a successful authoritaive
 * payment row. Offline/cash rows never satisfy completion, and free bookings
 * are the explicit exception.
 */
const loadSuccessfulServicePayment = async (booking) => {
  if (!booking || booking.paymentStatus !== "paid") return null;
  const payment = await Payment.findOne({
    bookingId: booking._id,
    status: "success",
  }).lean();
  if (!payment) return null;
  if (payment.itemType && payment.itemType !== "service") return null;
  if (isFreeServicePayment(payment)) return payment;
  return isSuccessfulServicePayment(payment) ? payment : null;
};

const assertServicePaymentSatisfied = async (booking) => {
  const payment = await loadSuccessfulServicePayment(booking);
  if (!payment) {
    throw fail(
      409,
      OTP_ERRORS.PAYMENT_REQUIRED,
      "Payment is required before completion OTP verification"
    );
  }
  return payment;
};

const notifyCompletionPaymentDue = async ({ booking, notifier = sendAppNotification, io = null }) => {
  if (!booking?.customerId) return;
  try {
    await notifier({
      userId: String(booking.customerId),
      recipientType: "customer",
      type: "PAYMENT_DUE",
      title: "Payment due for service completion",
      message:
        "Your technician has completed the work. Complete the payment to receive your completion OTP.",
      bookingId: booking._id,
      metadata: {
        socketEvent: SOCKET_EVENTS.PAYMENT_STATUS,
        stage: "completion_otp_requested",
        paymentStatus: booking.paymentStatus || "pending",
      },
      priority: "high",
      category: "payment",
      io,
    });
  } catch (err) {
    console.error("[completionOtp] payment-due notification failed:", err.message);
  }
};

const providerFailureDetails = (err) => ({
  error: err?.name || "SmsError",
  provider: err?.provider || null,
  providerStatus: err?.providerStatus ?? null,
  providerMessage: err?.providerMessage ? String(err.providerMessage).slice(0, 300) : null,
  requestId: err?.requestId || null,
});

const recordDeliveryFailure = async ({ bookingId, generation, operation, err }) => {
  const details = providerFailureDetails(err);
  // Masked phone / OTP / key / raw payload are never logged here.
  console.error(
    `[completionOtp] Delivery failed booking=${bookingId} generation=${generation} operation=${operation}`,
    details
  );
  await writeAuditLog({
    actorRole: "System",
    action: "COMPLETION_OTP_DELIVERY_FAILED",
    targetType: "ServiceBooking",
    targetId: bookingId,
    after: { generation, operation, ...details },
    metadata: { source: "completionVerification" },
  });
};

const deliveryFailureError = (err) =>
  fail(
    err?.provider === "fast2sms" ? 502 : err?.status || 503,
    OTP_ERRORS.NOT_PENDING,
    "OTP delivery temporarily unavailable — wait a minute, then resend"
  );

const deliverChallengeOtp = async ({
  booking,
  challenge,
  phone,
  otp,
  generation,
  smsSender,
  operation,
  onFailure = null,
}) => {
  try {
    await smsSender(phone, otp);
  } catch (err) {
    if (onFailure) {
      await onFailure(err).catch((rollbackErr) => {
        console.error("[completionOtp] Send rollback failed:", rollbackErr.message);
      });
    }
    await recordDeliveryFailure({
      bookingId: booking._id,
      generation,
      operation,
      err,
    });
    throw deliveryFailureError(err);
  }
  return markChallengeDelivering(challenge._id, { expectedGeneration: generation });
};

const assertSmsDeliveryConfigured = () => {
  const cfg = validateCompletionSmsConfig();
  if (!cfg.configured) {
    console.error(`[completionOtp] SMS delivery unavailable: ${cfg.reason}`);
    throw fail(503, OTP_ERRORS.NOT_PENDING, "OTP delivery is temporarily unavailable — please contact support");
  }
};

/** Fail with a clear 503 instead of a 500 when the HMAC pepper is missing. */
const assertOtpHashingConfigured = () => {
  try {
    getCompletionOtpPepper();
  } catch (err) {
    console.error(`[completionOtp] OTP hashing unavailable: ${err.message}`);
    throw fail(503, OTP_ERRORS.MISSING_PEPPER, "Completion verification is not configured — please contact support");
  }
};

/** Public (safe) projection — never OTP, hash, pepper, phone, or payload. */
export const publicChallengeState = (challenge) => {
  if (!challenge) return { verificationStatus: "none" };
  return {
    verificationStatus: challenge.status,
    generation: challenge.generation,
    attemptsLeft: Math.max(0, 5 - (challenge.attempts || 0)),
    resendsLeft: Math.max(0, OTP_MAX_RESENDS - (challenge.resendCount || 0)),
    expiresAt: challenge.expiresAt,
  };
};

const loadBookingOrFail = async (bookingId) => {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    throw fail(400, OTP_ERRORS.INVALID, "Invalid booking ID format");
  }
  const booking = await ServiceBooking.findById(bookingId).lean();
  if (!booking) throw fail(404, OTP_ERRORS.NOT_FOUND, "Booking not found");
  return booking;
};

const wasPreviouslyAssigned = (booking, technicianProfileId) =>
  (booking?.assignmentAttempts || []).some(
    (attempt) => toId(attempt.technicianId) === toId(technicianProfileId)
  );

/**
 * Ownership + status error, ordered so the technician who lost the assignment
 * sees the real reason (expired / no longer assigned) instead of a blanket
 * 403. An unrelated technician still gets the opaque 403.
 */
export const completionAccessError = (booking, technicianProfileId) => {
  if (!booking) return fail(404, OTP_ERRORS.NOT_FOUND, "Booking not found");

  const assignedTo = toId(booking.technicianId);
  const caller = toId(technicianProfileId);

  if (assignedTo && assignedTo !== caller) {
    return fail(403, OTP_ERRORS.INVALID, "Access denied for this booking");
  }
  if (!assignedTo && !wasPreviouslyAssigned(booking, technicianProfileId)) {
    return fail(403, OTP_ERRORS.INVALID, "Access denied for this booking");
  }
  if (booking.status === "expired" || booking.status === "cancelled") {
    return fail(410, OTP_ERRORS.NOT_PENDING, `Booking is ${booking.status}; completion is not possible`);
  }
  if (!assignedTo) {
    return fail(409, OTP_ERRORS.NOT_PENDING, "Booking is no longer assigned to you");
  }
  return null;
};

const assertCompletionAccess = async (booking, technicianProfileId) => {
  let err = completionAccessError(booking, technicianProfileId);

  // Legacy history repair: releases before this fix could record a null
  // technicianId in `assignmentAttempts`, so the attempt list alone cannot
  // prove the caller was assigned. A challenge created by this technician is
  // definitive proof; prefer the real reason over an opaque 403.
  if (err?.statusCode === 403 && !booking?.technicianId) {
    const priorChallenge = await ServiceCompletionChallenge.exists({
      bookingId: booking._id,
      technicianId: technicianProfileId,
    });
    if (priorChallenge) {
      err =
        booking.status === "expired" || booking.status === "cancelled"
          ? fail(410, OTP_ERRORS.NOT_PENDING, `Booking is ${booking.status}; completion is not possible`)
          : fail(409, OTP_ERRORS.NOT_PENDING, "Booking is no longer assigned to you");
    }
  }

  if (!err) return;
  if (err.statusCode === 410) {
    await closeActiveChallengesForBooking(booking._id, { to: "expired" }).catch((cleanupErr) => {
      console.error("[completionOtp] Stale challenge cleanup failed:", cleanupErr.message);
    });
  } else if (err.statusCode === 409 && !booking.technicianId) {
    await closeActiveChallengesForBooking(booking._id, { to: "cancelled" }).catch((cleanupErr) => {
      console.error("[completionOtp] Stale challenge cleanup failed:", cleanupErr.message);
    });
  }
  throw err;
};

/**
 * Activation parity with the legacy completion path: only approved,
 * profile-complete, activated technicians can complete jobs — whether
 * through OTP or (previously) direct status update.
 */
const assertTechnicianCanComplete = async (technicianProfileId) => {
  const technician = await TechnicianProfile.findById(technicianProfileId)
    .select("profileComplete workStatus")
    .lean();
  if (!technician) throw fail(404, OTP_ERRORS.INVALID, "Technician profile not found");
  if (!technician.profileComplete) {
    throw fail(403, OTP_ERRORS.INVALID, "Please complete your profile first");
  }
  const activation = await checkTechnicianActivation(technicianProfileId);
  if (!activation.isActive) {
    throw fail(403, OTP_ERRORS.INVALID, activation.message);
  }
  if (technician.workStatus !== "approved") {
    throw fail(403, OTP_ERRORS.INVALID, `Your account must be approved by owner before working. Status: ${technician.workStatus}`);
  }
};

/** Shared eligibility: bookable → completable, active, undisputed. */
const assertCompletionEligible = async (booking) => {
  const bookingStatus = normalizeBookingStatus(booking.status);
  if (bookingStatus === "completed") {
    const err = fail(409, OTP_ERRORS.CONSUMED, "Booking already completed");
    err.details = { bookingStatus: "completed", requiresCompletionOtp: false };
    throw err;
  }
  if (!canTransition(bookingStatus, "completed")) {
    throw fail(409, OTP_ERRORS.NOT_PENDING, `Booking in status "${booking.status}" cannot be completed`);
  }
  if (booking.cancellationStatus && booking.cancellationStatus !== "active") {
    throw fail(409, OTP_ERRORS.NOT_PENDING, "Booking is not active");
  }
  const dispute = await Report.findOne({
    bookingId: booking._id,
    status: { $in: ["open", "under_review"] },
  })
    .select("_id")
    .lean();
  if (dispute) {
    throw fail(409, OTP_ERRORS.NOT_PENDING, "Booking has an open dispute and cannot be completed");
  }
};

/**
 * Push the instant on-the-way deadline out once, when the first completion
 * OTP is requested. Without this the 30-minute travel timeout can release the
 * technician while the customer is reading/entering the code, after which
 * verify fails with "Access denied for this booking".
 *
 * Bounded: `completionPinnedAt` is written once per assignment and reset on
 * release, so resends/episodes cannot extend the deadline indefinitely.
 */
const pinBookingForCompletion = async (booking, technicianProfileId, now) => {
  if (booking.bookingType !== "instant" || booking.status !== "accepted" || !booking.autoCancelAt) {
    return;
  }

  const currentDeadline = new Date(booking.autoCancelAt).getTime();
  const graceUntil = new Date(Math.max(currentDeadline, now.getTime() + completionGraceMs()));

  const pinned = await ServiceBooking.findOneAndUpdate(
    {
      _id: booking._id,
      technicianId: technicianProfileId,
      status: "accepted",
      completionPinnedAt: null,
    },
    { $set: { autoCancelAt: graceUntil, completionPinnedAt: now } },
    { new: true }
  );

  if (pinned) {
    console.log(`[completionOtp] Pinned booking ${booking._id} until ${graceUntil.toISOString()}`);
    return;
  }

  // Already pinned (normal on resends) or the booking changed under us.
  const fresh = await ServiceBooking.findById(booking._id).lean();
  const err = completionAccessError(fresh, technicianProfileId);
  if (err) throw err;
  await assertCompletionEligible(fresh);
};

const activeChallengeFor = (bookingId) =>
  ServiceCompletionChallenge.findOne({
    bookingId,
    status: { $in: ["pending_delivery", "pending"] },
  });

/**
 * Request completion verification.
 *
 * The first request is a payment prompt: it pins the booking, stamps
 * `completionOtpRequestedAt`, persists a notification and emits the socket
 * event. No OTP challenge/SMS exists until the online payment succeeds.
 */
export const requestCompletionOtp = async ({
  bookingId,
  technicianProfileId,
  smsSender = sendCompletionSms,
  notifier = sendAppNotification,
  io = null,
}) => {
  const booking = await loadBookingOrFail(bookingId);
  await assertCompletionAccess(booking, technicianProfileId);
  await assertTechnicianCanComplete(technicianProfileId);
  await assertCompletionEligible(booking);
  // Fail before creating a payment obligation the system cannot fulfil.
  assertSmsDeliveryConfigured();
  assertOtpHashingConfigured();

  const phone = await loadCustomerPhone(booking.customerId);
  if (!isValidDeliveryPhone(phone)) {
    throw fail(409, OTP_ERRORS.NOT_PENDING, "Customer has no verified phone number for OTP delivery");
  }

  const now = new Date();
  await pinBookingForCompletion(booking, technicianProfileId, now);

  const marked = await ServiceBooking.findOneAndUpdate(
    { _id: booking._id, completionOtpRequestedAt: null },
    { $set: { completionOtpRequestedAt: now } },
    { new: true }
  );
  const fresh = marked || (await ServiceBooking.findById(booking._id).lean());
  if (!fresh) throw fail(404, OTP_ERRORS.NOT_FOUND, "Booking not found");

  const payment = await loadSuccessfulServicePayment(fresh);
  if (!payment) {
    if (marked) {
      await notifyCompletionPaymentDue({ booking: fresh, notifier, io });
    }
    return {
      bookingId: String(fresh._id),
      paymentRequired: true,
      paymentStatus: fresh.paymentStatus || "pending",
      verificationStatus: "awaiting_payment",
      completionOtpRequestedAt: fresh.completionOtpRequestedAt,
    };
  }

  return issueCompletionOtpForPaidBooking({
    bookingId: fresh._id,
    smsSender,
    notifier,
    io,
  });
};

/**
 * Issue/deliver the completion OTP after a successful online payment.
 * Idempotent: an already-delivered challenge is reused; a challenge stuck in
 * `pending_delivery` is rotated and re-driven. The marker is also backfilled
 * for legacy paid bookings.
 */
export const issueCompletionOtpForPaidBooking = async ({
  bookingId,
  smsSender = sendCompletionSms,
  notifier = sendAppNotification,
  io = null,
}) => {
  const booking = await loadBookingOrFail(bookingId);
  if (normalizeBookingStatus(booking.status) === "completed") {
    return {
      bookingId: String(booking._id),
      verificationStatus: "verified",
      requiresCompletionOtp: false,
      alreadyCompleted: true,
    };
  }
  await assertCompletionEligible(booking);
  await assertServicePaymentSatisfied(booking);
  if (!booking.technicianId) {
    throw fail(409, OTP_ERRORS.NOT_PENDING, "Booking is no longer assigned to a technician");
  }
  assertSmsDeliveryConfigured();
  assertOtpHashingConfigured();

  const phone = await loadCustomerPhone(booking.customerId);
  if (!isValidDeliveryPhone(phone)) {
    throw fail(409, OTP_ERRORS.NOT_PENDING, "Customer has no verified phone number for OTP delivery");
  }

  const now = new Date();
  await ServiceBooking.updateOne(
    { _id: booking._id, completionOtpRequestedAt: null },
    { $set: { completionOtpRequestedAt: now } }
  );

  let challenge = await activeChallengeFor(booking._id);
  if (challenge && toId(challenge.technicianId) !== toId(booking.technicianId)) {
    await closeCompletionChallenge(challenge._id, { to: "cancelled", now });
    challenge = null;
  }
  if (challenge && isChallengeExpired(challenge, now)) {
    await closeCompletionChallenge(challenge._id, { to: "expired", now });
    challenge = null;
  }
  if (challenge && challenge.status === "pending") {
    return { bookingId: String(booking._id), ...publicChallengeState(challenge), alreadyActive: true };
  }

  let generation = 1;
  let expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  let otp = generateCompletionOtp();

  if (challenge) {
    generation = challenge.generation + 1;
    const moved = await prepareCompletionChallengeDelivery(challenge._id, {
      expectedGeneration: challenge.generation,
      otpHash: hashCompletionOtp({ bookingId: booking._id, generation, otp }),
      expiresAt,
    });
    if (!moved) {
      const fresh = await activeChallengeFor(booking._id);
      if (!fresh) {
        throw fail(409, OTP_ERRORS.SUPERSEDED, "Challenge changed — retry the OTP request");
      }
      return { bookingId: String(booking._id), ...publicChallengeState(fresh), alreadyActive: true };
    }
    challenge = moved;
  } else {
    try {
      challenge = await ServiceCompletionChallenge.create({
        bookingId: booking._id,
        technicianId: booking.technicianId,
        customerId: booking.customerId,
        otpHash: hashCompletionOtp({ bookingId: booking._id, generation, otp }),
        generation,
        status: "pending_delivery",
        expiresAt,
        lastSentAt: now,
      });
    } catch (e) {
      if (e?.code !== 11000) throw e;
      challenge = await activeChallengeFor(booking._id);
      if (!challenge) {
        throw fail(409, OTP_ERRORS.SUPERSEDED, "Challenge changed — retry the OTP request");
      }
      return { bookingId: String(booking._id), ...publicChallengeState(challenge), alreadyActive: true };
    }
  }

  const delivering = await deliverChallengeOtp({
    booking,
    challenge,
    phone,
    otp,
    generation,
    smsSender,
    operation: "payment_success",
  });
  const result = { bookingId: String(booking._id), ...publicChallengeState(delivering || challenge) };

  // Best-effort: confirm to the customer that the paid OTP is on its way.
  try {
    await notifier({
      userId: String(booking.customerId),
      recipientType: "customer",
      type: "COMPLETION_OTP_SENT",
      title: "Completion OTP sent",
      message: "Payment received. Use the OTP sent to your registered mobile to finish the service.",
      bookingId: booking._id,
      metadata: { socketEvent: SOCKET_EVENTS.PAYMENT_SUCCESS, stage: "completion_otp_sent" },
      priority: "high",
      category: "payment",
      io,
    });
  } catch (err) {
    console.error("[completionOtp] payment-success notification failed:", err.message);
  }

  return result;
};

/**
 * Resend the OTP: new generation on the SAME doc (old code dies),
 * bounded by OTP_MAX_RESENDS. Crash recovery: a challenge stuck in
 * pending_delivery is re-driven here, never revived at an old generation.
 */
export const resendCompletionOtp = async ({
  bookingId,
  technicianProfileId,
  smsSender = sendCompletionSms,
  notifier = sendAppNotification,
  io = null,
}) => {
  const booking = await loadBookingOrFail(bookingId);
  await assertCompletionAccess(booking, technicianProfileId);
  await assertTechnicianCanComplete(technicianProfileId);
  await assertCompletionEligible(booking);
  await assertServicePaymentSatisfied(booking);
  assertSmsDeliveryConfigured();
  assertOtpHashingConfigured();

  const now = new Date();
  const challenge = await activeChallengeFor(booking._id);
  if (!challenge) {
    return issueCompletionOtpForPaidBooking({ bookingId: booking._id, smsSender, notifier, io });
  }
  if (toId(challenge.technicianId) !== toId(booking.technicianId)) {
    await closeCompletionChallenge(challenge._id, { to: "cancelled", now });
    throw fail(409, OTP_ERRORS.NOT_FOUND, "No active verification — request a new OTP first");
  }
  if (isChallengeExpired(challenge, now)) {
    await closeCompletionChallenge(challenge._id, { to: "expired", now });
    throw fail(410, OTP_ERRORS.EXPIRED, "OTP expired — request a new OTP");
  }

  const remainingMs = completionOtpCooldownRemainingMs(challenge, now);
  if (remainingMs > 0) throw rateLimited(remainingMs);

  if (challenge.status !== "pending_delivery" && (challenge.resendCount || 0) >= OTP_MAX_RESENDS) {
    throw fail(429, OTP_ERRORS.RESEND_EXCEEDED, "Resend limit reached — contact support");
  }

  const phone = await loadCustomerPhone(booking.customerId);
  if (!isValidDeliveryPhone(phone)) {
    throw fail(409, OTP_ERRORS.NOT_PENDING, "Customer has no verified phone number for OTP delivery");
  }

  // Idempotent safety net for challenges created before the pin existed.
  await pinBookingForCompletion(booking, technicianProfileId, now);

  const otp = generateCompletionOtp();
  const nextGen = challenge.generation + 1;
  const moved = await registerCompletionResend(challenge._id, {
    expectedGeneration: challenge.generation,
    otpHash: hashCompletionOtp({ bookingId: booking._id, generation: nextGen, otp }),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    ignoreResendBudget: challenge.status === "pending_delivery",
  });
  if (!moved) {
    throw fail(409, OTP_ERRORS.SUPERSEDED, "Challenge changed — fetch status and retry");
  }
  const delivering = await deliverChallengeOtp({
    booking,
    challenge: moved,
    phone,
    otp,
    generation: nextGen,
    smsSender,
    operation: "resend",
    onFailure: () => rollbackCompletionResend(challenge._id, { expectedGeneration: nextGen }),
  });
  return { bookingId: String(booking._id), ...publicChallengeState(delivering || moved) };
};

/**
 * Verify the customer OTP and flip the booking to completed — atomically.
 * Transaction: consume challenge (guarded) + version-guarded booking flip.
 * If the flip loses a race, the transaction aborts and consumption rolls
 * back with it. Returns the completed booking doc for post-commit side
 * effects (settlement + notifications, run by the caller as today).
 */
export const verifyCompletionOtp = async ({ bookingId, technicianProfileId, otp }) => {
  const now = new Date();
  const booking = await loadBookingOrFail(bookingId);
  await assertCompletionAccess(booking, technicianProfileId);
  await assertTechnicianCanComplete(technicianProfileId);
  await assertCompletionEligible(booking);
  // Payment is checked before OTP format so an unpaid verification always
  // reports PAYMENT_REQUIRED (the customer has no OTP yet in this flow).
  await assertServicePaymentSatisfied(booking);
  if (!OTP_PATTERN.test(String(otp || ""))) {
    throw fail(400, OTP_ERRORS.INVALID, "Invalid OTP format");
  }
  assertOtpHashingConfigured();

  const challenge = await ServiceCompletionChallenge.findOne({
    bookingId: booking._id,
    status: { $in: ["pending_delivery", "pending"] },
  })
    .select("+otpHash")
    .lean();
  if (!challenge) {
    // Distinguish consumed (verified booking would have flipped already —
    // unreachable here since eligible) from never-requested.
    throw fail(409, OTP_ERRORS.NOT_FOUND, "No active verification — request an OTP first");
  }
  if (toId(challenge.technicianId) !== toId(booking.technicianId)) {
    await closeCompletionChallenge(challenge._id, { to: "cancelled", now });
    throw fail(409, OTP_ERRORS.NOT_FOUND, "No active verification — request an OTP first");
  }

  // Crash-gap healing: provider may have accepted while the delivering
  // mark was lost. Promote guarded (a concurrent resend wins instead).
  let pending = challenge;
  if (challenge.status === "pending_delivery") {
    const promoted = await markChallengeDelivering(challenge._id, {
      expectedGeneration: challenge.generation,
    });
    if (!promoted) {
      throw fail(409, OTP_ERRORS.SUPERSEDED, "Challenge changed — fetch status and retry");
    }
    pending = { ...challenge, status: "pending" };
  }

  if (isChallengeExpired(pending, now)) {
    await closeCompletionChallenge(challenge._id, { to: "expired", now });
    throw fail(410, OTP_ERRORS.EXPIRED, "OTP expired — request a new OTP");
  }

  const candidate = hashCompletionOtp({
    bookingId: booking._id,
    generation: pending.generation,
    otp: String(otp),
  });
  if (!verifyCompletionOtpHash(pending.otpHash, candidate)) {
    // ONE count per HTTP attempt, outside any transaction (retry-safe).
    const after = await recordCompletionAttempt(challenge._id);
    if (!after || after.status === "locked") {
      throw fail(423, OTP_ERRORS.LOCKED, "Too many incorrect attempts — challenge locked, request a new OTP");
    }
    throw fail(400, OTP_ERRORS.INVALID, "Incorrect OTP");
  }

  // ── Atomic consume + flip ──
  const session = await mongoose.startSession();
  let completedBooking = null;
  try {
    await session.withTransaction(async () => {
      const consumed = await consumeCompletionChallenge(challenge._id, {
        expectedGeneration: pending.generation,
        now,
        session,
      });
      if (!consumed) {
        throw fail(409, OTP_ERRORS.SUPERSEDED, "OTP already used or superseded");
      }
      const versionPredicate =
        booking.version == null
          ? { _id: booking._id, version: { $exists: false } }
          : { _id: booking._id, version: booking.version };
      // Pin the exact pre-verification status: any interleaving transition
      // (cancel, dispute-driven change, concurrent write) aborts the flip
      // and rolls back consumption with it.
      const flipped = await ServiceBooking.updateOne(
        { ...versionPredicate, status: booking.status },
        {
          $set: {
            status: "completed",
            completedAt: now,
            assignmentStatus: "released",
            autoCancelAt: null,
          },
          $inc: { version: 1 },
        },
        { session }
      );
      if (flipped.modifiedCount !== 1) {
        // State moved under us (cancelled, disputed, concurrent write) —
        // abort rolls back the consumption above.
        throw fail(409, OTP_ERRORS.NOT_PENDING, "Booking changed during verification — reload and retry");
      }
      await writeAuditLog({
        actor: technicianProfileId,
        actorRole: "Technician",
        action: "COMPLETION_OTP_VERIFIED",
        targetType: "ServiceBooking",
        targetId: booking._id,
        after: { generation: pending.generation, completedAt: now },
        metadata: { source: "completionVerification" },
        session,
      });
      completedBooking = await ServiceBooking.findById(booking._id).session(session);
    });
  } finally {
    await session.endSession();
  }
  return { booking: completedBooking, generation: pending.generation };
};

/**
 * App-facing completion state. A completed booking is terminal: its verified
 * challenge is no longer "active", so without this branch the app would see
 * verificationStatus "none" and ask for another OTP after payment.
 */
export const buildCompletionStatus = (booking, challenge = null) => {
  const bookingStatus = normalizeBookingStatus(booking.status);
  const paymentStatus = booking.paymentStatus || "pending";
  const otpRequested = Boolean(booking.completionOtpRequestedAt);
  if (bookingStatus === "completed") {
    return {
      bookingId: String(booking._id),
      bookingStatus: "completed",
      paymentStatus,
      paymentConfirmed: paymentStatus === "paid",
      otpRequested,
      paymentDue: false,
      verificationStatus: "verified",
      requiresCompletionOtp: false,
      completedAt: booking.completedAt || null,
    };
  }
  const eligible = canTransition(bookingStatus, "completed");
  const paymentDue = eligible && otpRequested && paymentStatus !== "paid";
  return {
    bookingId: String(booking._id),
    bookingStatus,
    paymentStatus,
    paymentConfirmed: paymentStatus === "paid",
    otpRequested,
    paymentDue,
    completionOtpRequestedAt: booking.completionOtpRequestedAt || null,
    requiresCompletionOtp: eligible && paymentStatus === "paid",
    ...publicChallengeState(challenge),
  };
};

/**
 * Safe status for technician / customer / admin. Never OTP, hash, pepper,
 * provider payload, or phone numbers.
 */
export const getCompletionStatus = async ({ bookingId, technicianProfileId = null, customerId = null, isAdmin = false }) => {
  const booking = await loadBookingOrFail(bookingId);
  const mine =
    isAdmin ||
    (technicianProfileId && toId(booking.technicianId) === toId(technicianProfileId)) ||
    (customerId && toId(booking.customerId) === toId(customerId));
  if (!mine) throw fail(404, OTP_ERRORS.NOT_FOUND, "Booking not found");
  const challenge = await activeChallengeFor(booking._id).lean();
  return buildCompletionStatus(booking, challenge);
};
