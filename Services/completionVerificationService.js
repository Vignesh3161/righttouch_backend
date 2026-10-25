/**
 * ✅ SERVICE COMPLETION VERIFICATION (Checkpoint C).
 *
 * Customer-confirmed job completion: the technician requests a 4-digit OTP,
 * the customer receives it by SMS, the technician submits it, and the
 * booking flips to `completed` ONLY inside the same transaction that
 * consumes the challenge.
 *
 * Boundaries (deliberate):
 *  - This service moves NO money. After commit, the caller runs the
 *    EXISTING completion side effects (settleBookingEarningsIfEligible +
 *    notifications) exactly as updateBookingStatus does today.
 *  - Attempt counting happens OUTSIDE the transaction (one HTTP attempt =
 *    one count); transaction retries only wrap consume+flip, so a retry
 *    can never double-count an incorrect attempt.
 *  - SMS is sent AFTER the challenge commit (provider calls never run
 *    inside a MongoDB transaction). Crash gap documented in
 *    Utils/sendCompletionSms.js; resend re-drives delivery.
 */
import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import ServiceCompletionChallenge from "../Schemas/ServiceCompletionChallenge.js";
import User from "../Schemas/User.js";
import Report from "../Schemas/Report.js";
import { canTransition } from "../Utils/bookingStatus.js";
import {
  OTP_PATTERN,
  OTP_TTL_MS,
  OTP_MAX_RESENDS,
  OTP_ERRORS,
  otpError,
  generateCompletionOtp,
  hashCompletionOtp,
  verifyCompletionOtpHash,
  isChallengeExpired,
  recordCompletionAttempt,
  registerCompletionResend,
  rollbackCompletionResend,
  markChallengeDelivering,
  consumeCompletionChallenge,
  closeCompletionChallenge,
  closeActiveChallengesForBooking,
} from "../Utils/completionOtp.js";
import { sendCompletionSms, validateCompletionSmsConfig } from "../Utils/sendCompletionSms.js";
import { writeAuditLog } from "../Utils/audit.js";
import { checkTechnicianActivation } from "../Utils/technicianActivation.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

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
  if (booking.status === "completed") {
    throw fail(409, OTP_ERRORS.CONSUMED, "Booking already completed");
  }
  if (!canTransition(booking.status, "completed")) {
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
 * Request a completion OTP.
 *
 * - An expired challenge is closed and replaced.
 * - An active challenge inside the send cooldown returns 429 with
 *   `retryAfterSeconds`; it never reports success without sending an SMS.
 * - After the cooldown the SAME challenge is re-driven with a new generation
 *   (old code dies), respecting the resend budget for `pending` challenges and
 *   ignoring it for `pending_delivery` crash recovery.
 * - Concurrent creation races collide on the partial unique index — the loser
 *   loads and returns the winner instead of creating a second OTP.
 */
export const requestCompletionOtp = async ({ bookingId, technicianProfileId, smsSender = sendCompletionSms }) => {
  const booking = await loadBookingOrFail(bookingId);
  await assertCompletionAccess(booking, technicianProfileId);
  await assertTechnicianCanComplete(technicianProfileId);
  await assertCompletionEligible(booking);
  assertSmsDeliveryConfigured();

  const phone = await loadCustomerPhone(booking.customerId);
  if (!isValidDeliveryPhone(phone)) {
    throw fail(409, OTP_ERRORS.NOT_PENDING, "Customer has no verified phone number for OTP delivery");
  }

  const now = new Date();
  await pinBookingForCompletion(booking, technicianProfileId, now);

  let challenge = await activeChallengeFor(booking._id);
  // Safety net for pre-deploy releases that left a challenge behind: an OTP
  // issued to a previous assignee must never block the current technician.
  if (challenge && toId(challenge.technicianId) !== toId(booking.technicianId)) {
    await closeCompletionChallenge(challenge._id, { to: "cancelled", now });
    challenge = null;
  }
  if (challenge && isChallengeExpired(challenge, now)) {
    await closeCompletionChallenge(challenge._id, { to: "expired", now });
    challenge = null;
  }

  if (challenge) {
    const remainingMs = completionOtpCooldownRemainingMs(challenge, now);
    if (remainingMs > 0) throw rateLimited(remainingMs);

    const otp = generateCompletionOtp();
    const generation = challenge.generation + 1;
    const moved = await registerCompletionResend(challenge._id, {
      expectedGeneration: challenge.generation,
      otpHash: hashCompletionOtp({ bookingId: booking._id, generation, otp }),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      ignoreResendBudget: challenge.status === "pending_delivery",
    });
    if (!moved) {
      const fresh = await activeChallengeFor(booking._id);
      if (!fresh) {
        throw fail(409, OTP_ERRORS.SUPERSEDED, "Challenge changed — fetch status and retry");
      }
      const freshRemainingMs = completionOtpCooldownRemainingMs(fresh, new Date());
      if (freshRemainingMs > 0) throw rateLimited(freshRemainingMs);
      throw fail(429, OTP_ERRORS.RESEND_EXCEEDED, "Resend limit reached — contact support");
    }

    const delivering = await deliverChallengeOtp({
      booking,
      challenge: moved,
      phone,
      otp,
      generation,
      smsSender,
      operation: "request_redrive",
      onFailure: () => rollbackCompletionResend(challenge._id, { expectedGeneration: generation }),
    });
    return { bookingId: String(booking._id), ...publicChallengeState(delivering || moved) };
  }

  const otp = generateCompletionOtp();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  try {
    challenge = await ServiceCompletionChallenge.create({
      bookingId: booking._id,
      technicianId: booking.technicianId,
      customerId: booking.customerId,
      otpHash: hashCompletionOtp({ bookingId: booking._id, generation: 1, otp }),
      generation: 1,
      status: "pending_delivery",
      expiresAt,
      lastSentAt: now,
    });
  } catch (e) {
    if (e?.code !== 11000) throw e;
    // Lost the creation race — return the winner's public state.
    challenge = await activeChallengeFor(booking._id);
    if (!challenge) {
      throw fail(409, OTP_ERRORS.SUPERSEDED, "Challenge changed — fetch status and retry");
    }
    const remainingMs = completionOtpCooldownRemainingMs(challenge, new Date());
    return {
      bookingId: String(booking._id),
      ...publicChallengeState(challenge),
      alreadyActive: true,
      retryAfterSeconds: Math.ceil(remainingMs / 1000),
    };
  }

  // Delivery AFTER commit (never inside a transaction).
  const delivering = await deliverChallengeOtp({
    booking,
    challenge,
    phone,
    otp,
    generation: 1,
    smsSender,
    operation: "request",
  });
  return { bookingId: String(booking._id), ...publicChallengeState(delivering || challenge) };
};

/**
 * Resend the OTP: new generation on the SAME doc (old code dies),
 * bounded by OTP_MAX_RESENDS. Crash recovery: a challenge stuck in
 * pending_delivery is re-driven here, never revived at an old generation.
 */
export const resendCompletionOtp = async ({ bookingId, technicianProfileId, smsSender = sendCompletionSms }) => {
  const booking = await loadBookingOrFail(bookingId);
  await assertCompletionAccess(booking, technicianProfileId);
  await assertTechnicianCanComplete(technicianProfileId);
  await assertCompletionEligible(booking);
  assertSmsDeliveryConfigured();

  const now = new Date();
  const challenge = await activeChallengeFor(booking._id);
  if (!challenge) {
    throw fail(409, OTP_ERRORS.NOT_FOUND, "No active verification — request a new OTP first");
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
  if (!OTP_PATTERN.test(String(otp || ""))) {
    throw fail(400, OTP_ERRORS.INVALID, "Invalid OTP format");
  }
  const now = new Date();
  const booking = await loadBookingOrFail(bookingId);
  await assertCompletionAccess(booking, technicianProfileId);
  await assertTechnicianCanComplete(technicianProfileId);
  await assertCompletionEligible(booking);

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
  return {
    bookingId: String(booking._id),
    bookingStatus: booking.status,
    ...publicChallengeState(challenge),
  };
};
