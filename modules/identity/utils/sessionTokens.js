import crypto from "crypto";
import { signToken, resolveAccessTokenLifetimeMs, parseLifetimeToMs } from "./token.js";

// Re-exported for compatibility (single implementation lives in token.js).
export { parseLifetimeToMs };

/**
 * P5 — refresh/access token primitives.
 *
 * - Refresh tokens: 48 bytes of CSPRNG entropy (384 bits), base64url.
 *   Only SHA-256 hex (`tokenHash`) is persisted/looked up/compared —
 *   the raw value exists only in memory and in the one response that
 *   delivers it to the owning client. Never logged.
 * - Access tokens (P6): short-lived via the token.js resolver (default
 *   1h). P5 ADDS `sid` + `tokenVersion` claims. All pre-existing claims
 *   (userId/role/technicianProfileId) are preserved.
 * - Refresh/AuthSession lifetime is 30 days SLIDING per rotation (each
 *   rotation issues expiresAt = now + 30d) and is NEVER derived from the
 *   access-token value. P9: the old "absolute" wording was inaccurate.
 */

export const REFRESH_TOKEN_BYTES = 48;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days absolute

export const generateRefreshToken = () =>
  crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");

export const hashRefreshToken = (rawToken) =>
  crypto.createHash("sha256").update(String(rawToken), "utf8").digest("hex");

/** Access-token TTL in seconds, derived from the same source as signToken. */
export const accessTokenExpiresInSeconds = () =>
  Math.floor(resolveAccessTokenLifetimeMs() / 1000);

/**
 * Sign a session-aware access token. Pre-existing claims pass through
 * untouched; `sid` + `tokenVersion` are additive.
 */
export const signSessionAccessToken = ({ userId, role, technicianProfileId, tokenVersion, sid }) => {
  const payload = { userId, role, tokenVersion, sid };
  if (technicianProfileId !== undefined && technicianProfileId !== null) {
    payload.technicianProfileId = technicianProfileId;
  }
  return signToken(payload);
};
