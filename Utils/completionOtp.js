/**
 * 🔐 COMPLETION OTP PRIMITIVES (Checkpoint B — no controllers/routes).
 *
 * Pure crypto helpers + atomic MongoDB primitives for the service-completion
 * challenge. The verification service (Checkpoint C) will call these INSIDE
 * the existing booking transaction — every state change below is a single
 * atomic update, never read-then-write.
 *
 * Security:
 *  - 4-digit code from crypto.randomInt (never Math.random).
 *  - HMAC-SHA256 with an INDEPENDENT pepper (COMPLETION_OTP_PEPPER),
 *    bound to `${bookingId}:${generation}:${otp}`.
 *  - Comparison via timingSafeEqual after digest-length validation.
 *  - Plaintext OTP exists only in the caller's memory (to hand to SMS);
 *    only the hex digest is persisted.
 */
import crypto from "node:crypto";

import ServiceCompletionChallenge from "../Schemas/ServiceCompletionChallenge.js";

export const OTP_LENGTH = 4;
export const OTP_PATTERN = new RegExp(`^\\d{${OTP_LENGTH}}$`);
export const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_RESENDS = 3;

export const OTP_ERRORS = {
  MISSING_PEPPER: "MISSING_PEPPER",
  INVALID: "INVALID",
  EXPIRED: "EXPIRED",
  LOCKED: "LOCKED",
  CONSUMED: "CONSUMED",
  SUPERSEDED: "SUPERSEDED",
  NOT_FOUND: "NOT_FOUND",
  ATTEMPTS_EXCEEDED: "ATTEMPTS_EXCEEDED",
  RESEND_EXCEEDED: "RESEND_EXCEEDED",
  NOT_PENDING: "NOT_PENDING",
};

export const otpError = (code, message) => {
  const err = new Error(message || code);
  err.code = code;
  return err;
};

/** Independent pepper — never JWT/Razorpay/KYC secrets. Throws when absent. */
export const getCompletionOtpPepper = () => {
  const pepper = process.env.COMPLETION_OTP_PEPPER;
  if (!pepper || pepper.length < 16) {
    throw otpError(
      OTP_ERRORS.MISSING_PEPPER,
      "COMPLETION_OTP_PEPPER is missing or too weak (>=16 chars required)"
    );
  }
  return pepper;
};

/** Cryptographically secure 4-digit code, zero-padded. */
export const generateCompletionOtp = () =>
  crypto.randomInt(0, 10_000).toString().padStart(OTP_LENGTH, "0");

/** HMAC-SHA256 hex digest bound to booking + generation. */
export const hashCompletionOtp = ({ bookingId, generation, otp, pepper = null }) => {
  const key = pepper ?? getCompletionOtpPepper();
  return crypto
    .createHmac("sha256", key)
    .update(`${String(bookingId)}:${Number(generation)}:${String(otp)}`)
    .digest("hex");
};

/**
 * Timing-safe comparison. Validates both digests are 64-char hex BEFORE
 * touching timingSafeEqual (it throws on length mismatch, which would
 * otherwise leak validity via exception type).
 */
export const verifyCompletionOtpHash = (expectedHex, candidateHex) => {
  const hexRe = /^[0-9a-f]{64}$/;
  if (!hexRe.test(expectedHex || "") || !hexRe.test(candidateHex || "")) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expectedHex, "hex"),
    Buffer.from(candidateHex, "hex")
  );
};

export const isChallengeExpired = (challenge, now = new Date()) =>
  !challenge?.expiresAt || new Date(challenge.expiresAt).getTime() <= now.getTime();

// ── Atomic primitives (safe inside transactions; session optional) ───────

/**
 * Record one failed attempt atomically. Single pipeline update: $inc +
 * conditional lock — concurrent attempts can never lose counts or
 * double-pass the cap. Returns the fresh doc.
 */
export const recordCompletionAttempt = async (challengeId, { session = null } = {}) => {
  const opts = session ? { session } : {};
  return ServiceCompletionChallenge.findOneAndUpdate(
    { _id: challengeId, status: "pending" },
    [
      {
        $set: {
          attempts: { $add: [{ $ifNull: ["$attempts", 0] }, 1] },
          lastAttemptAt: "$$NOW",
          status: {
            $cond: [
              { $gte: [{ $add: [{ $ifNull: ["$attempts", 0] }, 1] }, OTP_MAX_ATTEMPTS] },
              "locked",
              "$status",
            ],
          },
          lockedAt: {
            $cond: [
              { $gte: [{ $add: [{ $ifNull: ["$attempts", 0] }, 1] }, OTP_MAX_ATTEMPTS] },
              "$$NOW",
              "$lockedAt",
            ],
          },
        },
      },
    ],
    { new: true, ...opts }
  );
};

/**
 * Register a resend: new generation + new hash, attempts preserved
 * (cumulative cap), guarded on expected generation + resend budget.
 * Returns the fresh doc, or null when the guard fails.
 */
export const registerCompletionResend = async (
  challengeId,
  { expectedGeneration, otpHash, expiresAt, session = null } = {}
) => {
  const opts = session ? { session } : {};
  return ServiceCompletionChallenge.findOneAndUpdate(
    {
      _id: challengeId,
      status: { $in: ["pending", "pending_delivery"] },
      generation: expectedGeneration,
      resendCount: { $lt: OTP_MAX_RESENDS },
    },
    {
      $set: {
        otpHash,
        generation: expectedGeneration + 1,
        expiresAt,
        status: "pending_delivery",
        lastAttemptAt: new Date(),
      },
      $inc: { resendCount: 1 },
    },
    { new: true, ...opts }
  );
};

/**
 * Delivery confirmed by provider: pending_delivery → pending, guarded on
 * generation (a concurrent resend wins instead — no revival of old codes).
 */
export const markChallengeDelivering = async (
  challengeId,
  { expectedGeneration, session = null } = {}
) => {
  const opts = session ? { session } : {};
  return ServiceCompletionChallenge.findOneAndUpdate(
    { _id: challengeId, status: "pending_delivery", generation: expectedGeneration },
    { $set: { status: "pending" } },
    { new: true, ...opts }
  );
};

/**
 * Atomically consume a challenge: pending → verified + consumedAt, guarded
 * on generation and expiry. The ONLY writer of the verified transition.
 * Returns the doc, or null when already consumed/expired/superseded.
 */
export const consumeCompletionChallenge = async (
  challengeId,
  { expectedGeneration, now = new Date(), session = null } = {}
) => {
  const opts = session ? { session } : {};
  return ServiceCompletionChallenge.findOneAndUpdate(
    {
      _id: challengeId,
      status: "pending",
      generation: expectedGeneration,
      expiresAt: { $gt: now },
    },
    { $set: { status: "verified", verifiedAt: now, consumedAt: now } },
    { new: true, ...opts }
  );
};

/** Terminal transition helper (expired / cancelled) — guarded, idempotent. */
export const closeCompletionChallenge = async (
  challengeId,
  { to, now = new Date(), session = null } = {}
) => {
  if (!["expired", "cancelled"].includes(to)) {
    throw otpError(OTP_ERRORS.INVALID, `Invalid terminal transition: ${to}`);
  }
  const opts = session ? { session } : {};
  const field = to === "expired" ? "expiredAt" : null;
  return ServiceCompletionChallenge.findOneAndUpdate(
    { _id: challengeId, status: { $in: ["pending", "pending_delivery"] } },
    { $set: { status: to, ...(field ? { [field]: now } : {}) } },
    { new: true, ...opts }
  );
};
