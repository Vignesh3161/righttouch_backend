import crypto from "node:crypto";

/** Canonical 4-digit OTP length shared by auth and service-completion OTPs. */
export const OTP_LENGTH = 4;

/**
 * Cryptographically secure 4-digit OTP (no leading zero).
 * Auth and service completion both use this exact generator; only the
 * storage/verification flow differs.
 */
export const generateSecureOtp = () => crypto.randomInt(1_000, 10_000).toString();
