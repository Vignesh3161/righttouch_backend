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

// P6 — access-token lifetime: short-lived by default (1h). Configurable
// via JWT_ACCESS_EXPIRES_IN (preferred) with JWT_EXPIRES_IN honored as a
// legacy fallback so operators who tuned the old variable keep their
// explicit choice. Format: jsonwebtoken-compatible strings parsed below
// ("1h", "30m", "3600s", "7d"). Resolved per call (cheap) so process
// lifetime never pins a stale value and tests can override via env.
// The 30-day refresh/AuthSession lifetime is SEPARATE (sessionTokens.js)
// and is never derived from this value.
const DEFAULT_ACCESS_LIFETIME = "1h";
const MAX_WARN_MS = 24 * 3600 * 1000;

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 };

/** Parse project JWT lifetime strings to ms; null when unparseable. */
export const parseLifetimeToMs = (value) => {
  const m = /^(\d+)\s*([smhd])$/i.exec(String(value || "").trim());
  if (!m) return null;
  const ms = Number(m[1]) * (UNIT_MS[m[2].toLowerCase()] || 0);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

/** Raw configured string (for diagnostics/tests). */
export const configuredAccessLifetime = () =>
  process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || DEFAULT_ACCESS_LIFETIME;

/** Validated lifetime ms. Throws fail-closed (never an insecure token). */
export const resolveAccessTokenLifetimeMs = () => {
  const raw = configuredAccessLifetime();
  const ms = parseLifetimeToMs(raw);
  if (ms === null) {
    throw new Error(
      `Invalid access-token lifetime ${JSON.stringify(raw)} — set JWT_ACCESS_EXPIRES_IN to a value like "1h", "30m" or "3600s"`
    );
  }
  if (ms > MAX_WARN_MS) {
    console.warn(
      `⚠️ JWT access lifetime ${raw} exceeds 24h — access tokens should stay short-lived; persistence comes from refresh sessions`
    );
  }
  return ms;
};

/** Production default in ms (regression-guard target; must stay short). */
export const defaultAccessLifetimeMs = () => parseLifetimeToMs(DEFAULT_ACCESS_LIFETIME);

export const signToken = (payload) => {
  // Validated every issuance: misconfiguration throws instead of minting
  // a token with an unintended lifetime.
  const raw = configuredAccessLifetime();
  if (parseLifetimeToMs(raw) === null) {
    throw new Error(
      `Invalid access-token lifetime ${JSON.stringify(raw)} — set JWT_ACCESS_EXPIRES_IN to a value like "1h", "30m" or "3600s"`
    );
  }
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: raw,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  });
};

export const verifyTokenOptions = () => ({
  algorithms: [ALGORITHM],
  ignoreExpiration: false, // sessions MUST expire; legacy tokens without exp still verify until rotated
  ...(issuer ? { issuer } : {}),
  ...(audience ? { audience } : {}),
});
