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
// MUST stay in sync with client re-login handling.
const expiresIn = process.env.JWT_EXPIRES_IN || "7d";

export const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  });

export const verifyTokenOptions = () => ({
  algorithms: [ALGORITHM],
  ignoreExpiration: false, // sessions MUST expire; legacy tokens without exp still verify until rotated
  ...(issuer ? { issuer } : {}),
  ...(audience ? { audience } : {}),
});
