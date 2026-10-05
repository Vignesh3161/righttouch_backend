import crypto from "crypto";
import { signToken } from "./token.js";

/**
 * P5 — refresh/access token primitives.
 *
 * - Refresh tokens: 48 bytes of CSPRNG entropy (384 bits), base64url.
 *   Only SHA-256 hex (`tokenHash`) is persisted/looked up/compared —
 *   the raw value exists only in memory and in the one response that
 *   delivers it to the owning client. Never logged.
 * - Access tokens: unchanged HS256/JWT lifetime (P6 owns tightening);
 *   P5 only ADDS `sid` + `tokenVersion` claims. All pre-existing claims
 *   (userId/role/technicianProfileId) are preserved.
 */

export const REFRESH_TOKEN_BYTES = 48;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days absolute

export const generateRefreshToken = () =>
  crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");

export const hashRefreshToken = (rawToken) =>
  crypto.createHash("sha256").update(String(rawToken), "utf8").digest("hex");

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 };

/** Parse the project's JWT lifetime strings ("7d", "12h", "30m") to ms. */
export const parseLifetimeToMs = (value, fallbackMs) => {
  const m = /^(\d+)\s*([smhd])$/i.exec(String(value || "").trim());
  if (!m) return fallbackMs;
  return Number(m[1]) * (UNIT_MS[m[2].toLowerCase()] || 0) || fallbackMs;
};

/** Access-token TTL in seconds, derived from the same source as signToken. */
export const accessTokenExpiresInSeconds = () =>
  Math.floor(
    parseLifetimeToMs(
      process.env.JWT_EXPIRES_IN || "7d",
      7 * 24 * 3600 * 1000
    ) / 1000
  );

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
