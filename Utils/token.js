import jwt from "jsonwebtoken";

// Centralized JWT signing/verification.
//
// Security posture (Remediation Plan §4):
//  • Algorithm is ALWAYS pinned to HS256 (prevents alg-confusion attacks).
//  • `iss`/`aud` are OPT-IN via env (JWT_ISSUER / JWT_AUDIENCE). When unset,
//    tokens are signed/verified without them so existing发行的 tokens keep
//    working; once an operator sets them, both sides enforce them consistently.
//    This lets you turn on strict binding without a forced re-login of every
//    user.
const ALGORITHM = "HS256";

const issuer = process.env.JWT_ISSUER || undefined;
const audience = process.env.JWT_AUDIENCE || undefined;

// Session lifetime: env-overridable, defaults to 7 days for mobile apps.
// Privileged dashboard accounts use a short access token and rely on the
// rotating refresh token. MUST stay in sync with client re-login handling.
const defaultExpiresIn = process.env.JWT_EXPIRES_IN || "7d";
const privilegedExpiresIn = process.env.JWT_PRIVILEGED_EXPIRES_IN || "1h";

const PRIVILEGED_ROLES = new Set(["Owner", "Admin"]);

export const accessTokenExpiresIn = (role) =>
  PRIVILEGED_ROLES.has(role) ? privilegedExpiresIn : defaultExpiresIn;

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

// JWT accepts "30m"/"7d"; API clients need a numeric `expires_in`.
export const durationToSeconds = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  const match = String(value || "").trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return amount * (UNIT_SECONDS[unit] || 0);
};

export const signToken = (payload, options = {}) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: options.expiresIn || defaultExpiresIn,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  });

export const verifyTokenOptions = () => ({
  algorithms: [ALGORITHM],
  ignoreExpiration: false, // sessions MUST expire; legacy tokens without exp still verify until rotated
  ...(issuer ? { issuer } : {}),
  ...(audience ? { audience } : {}),
});
