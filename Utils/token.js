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
const TOKEN_TTL = process.env.JWT_EXPIRES_IN || "30d";

const issuer = process.env.JWT_ISSUER || undefined;
const audience = process.env.JWT_AUDIENCE || undefined;

export const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: TOKEN_TTL,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  });

export const verifyTokenOptions = () => ({
  algorithms: [ALGORITHM],
  ...(issuer ? { issuer } : {}),
  ...(audience ? { audience } : {}),
});
