/**
 * ✅ SERVICE COMPLETION VERIFICATION (Checkpoint C).
 *
 * Customer-confirmed job completion: the technician requests a 6-digit OTP,
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
  markChallengeDelivering,
  consumeCompletionChallenge,
  closeCompletionChallenge,
} from "../Utils/completionOtp.js";
import { sendCompletionSms } from "../Utils/sendCompletionSms.js";
import { writeAuditLog } from "../Utils/audit.js";
import { checkTechnicianActivation } from "../Utils/technicianActivation.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

const fail = (statusCode, code, message) => {
  const err = otpError(code, message);
  err.statusCode = statusCode;
  return err;
};

const toId = (v) => (v == null ? null : String(v));

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

const assertTechnicianOwns = (booking, technicianProfileId) => {
  if (!technicianProfileId || !booking.technicianId || toId(booking.technicianId) !== toId(technicianProfileId)) {
    throw fail(403, OTP_ERRORS.INVALID, "Access denied for this booking");
  }
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

const activeChallengeFor = (bookingId) =>
  ServiceCompletionChallenge.findOne({
    bookingId,
    status: { $in: ["pending_delivery", "pending"] },
  });

/**
 * Request a completion OTP. Idempotent: an unexpired active challenge is
 * returned as-is (no new SMS storm); an expired one is closed and replaced.
 * Concurrent requests collide on the partial unique index — the loser
 * loads and returns the winner (never a second OTP).
 */
export const requestCompletionOtp = async ({ bookingId, technicianProfileId, smsSender = sendCompletionSms }) => {
  const booking = await loadBookingOrFail(bookingId);
  assertTechnicianOwns(booking, technicianProfileId);
  await assertTechnicianCanComplete(technicianProfileId);
  await assertCompletionEligible(booking);

  const now = new Date();
  let challenge = await activeChallengeFor(booking._id);
  if (challenge && isChallengeExpired(challenge, now)) {
    await closeCompletionChallenge(challenge._id, { to: "expired", now });
    challenge = null;
  }
  if (challenge) {
    return { bookingId: String(booking._id), ...publicChallengeState(challenge), alreadyActive: true };
  }

  const customer = await User.findById(booking.customerId).select("mobileNumber").lean();
  const phone = String(customer?.mobileNumber || "").replace(/\D/g, "");
  if (!/^[0-9]{10}$/.test(phone) && !(phone.length === 12 && phone.startsWith("91"))) {
    throw fail(409, OTP_ERRORS.NOT_PENDING, "Customer has no verified phone number for OTP delivery");
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
    });
  } catch (e) {
    if (e?.code !== 11000) throw e;
    // Lost the creation race — return the winner's public state.
    challenge = await activeChallengeFor(booking._id);
    return { bookingId: String(booking._id), ...publicChallengeState(challenge), alreadyActive: true };
  }

  // Delivery AFTER commit (never inside a transaction).
  try {
    await smsSender(phone, otp);
  } catch (err) {
    // Challenge stays pending_delivery for resend recovery; OTP never leaks.
    await writeAuditLog({
      actorRole: "System",
      action: "COMPLETION_OTP_DELIVERY_FAILED",
      targetType: "ServiceBooking",
      targetId: booking._id,
      after: { generation: 1, error: err.name || "SmsError" },
      metadata: { source: "completionVerification" },
    });
    throw fail(err.status || 503, OTP_ERRORS.NOT_PENDING, "OTP delivery temporarily unavailable — retry or resend");
  }
  const delivering = await markChallengeDelivering(challenge._id, { expectedGeneration: 1 });
  return { bookingId: String(booking._id), ...publicChallengeState(delivering || challenge) };
};

/**
 * Resend the OTP: new generation on the SAME doc (old code dies),
 * bounded by OTP_MAX_RESENDS. Crash recovery: a challenge stuck in
 * pending_delivery is re-driven here, never revived at an old generation.
 */
export const resendCompletionOtp = async ({ bookingId, technicianProfileId, smsSender = sendCompletionSms }) => {
  const booking = await loadBookingOrFail(bookingId);
  assertTechnicianOwns(booking, technicianProfileId);
  await assertTechnicianCanComplete(technicianProfileId);
  await assertCompletionEligible(booking);

  const now = new Date();
  const challenge = await activeChallengeFor(booking._id);
  if (!challenge) {
    throw fail(409, OTP_ERRORS.NOT_FOUND, "No active verification — request a new OTP first");
  }
  if (isChallengeExpired(challenge, now)) {
    await closeCompletionChallenge(challenge._id, { to: "expired", now });
    throw fail(410, OTP_ERRORS.EXPIRED, "OTP expired — request a new OTP");
  }
  if ((challenge.resendCount || 0) >= OTP_MAX_RESENDS) {
    throw fail(429, OTP_ERRORS.RESEND_EXCEEDED, "Resend limit reached — contact support");
  }

  const customer = await User.findById(booking.customerId).select("mobileNumber").lean();
  const phone = String(customer?.mobileNumber || "").replace(/\D/g, "");

  const otp = generateCompletionOtp();
  const nextGen = challenge.generation + 1;
  const moved = await registerCompletionResend(challenge._id, {
    expectedGeneration: challenge.generation,
    otpHash: hashCompletionOtp({ bookingId: booking._id, generation: nextGen, otp }),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
  });
  if (!moved) {
    throw fail(409, OTP_ERRORS.SUPERSEDED, "Challenge changed — fetch status and retry");
  }
  try {
    await smsSender(phone, otp);
  } catch (err) {
    throw fail(err.status || 503, OTP_ERRORS.NOT_PENDING, "OTP delivery temporarily unavailable — retry resend");
  }
  const delivering = await markChallengeDelivering(challenge._id, { expectedGeneration: nextGen });
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
  if (!/^\d{6}$/.test(String(otp || ""))) {
    throw fail(400, OTP_ERRORS.INVALID, "Invalid OTP format");
  }
  const now = new Date();
  const booking = await loadBookingOrFail(bookingId);
  assertTechnicianOwns(booking, technicianProfileId);
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
