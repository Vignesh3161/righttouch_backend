/**
 * P9 — security observability events.
 *
 * Auth-lifecycle signals (login, OTP, refresh, logout) previously left no
 * audit trail — only console output. These helpers route them through the
 * existing writeAuditLog infrastructure with the project's UPPER_SNAKE
 * action convention.
 *
 * Privacy rules (hard):
 * - NEVER pass OTP values, passwords, raw tokens, or JWTs.
 * - Identifiers (mobile/email) and IPs are SHA-256 hashed (truncated) —
 *   correlatable for abuse detection, not reversible from the log.
 * - Fire-and-forget: writeAuditLog never throws, and callers MUST NOT
 *   await (auth latency must not depend on the audit write).
 */
import crypto from "crypto";
import { writeAuditLog } from "../../../shared/utils/audit.js";

const hash = (value) => {
  if (!value || typeof value !== "string") return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
};

export const hashIdentifier = (identifier) => hash(String(identifier || "").trim());

export const ipHashFromRequest = (req) =>
  hash(
    req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req?.ip ||
      req?.socket?.remoteAddress ||
      ""
  );

/**
 * Fire-and-forget security event. Returns nothing (do not await).
 */
export const emitSecurityEvent = ({ actor = null, actorRole = null, action, reason = null, metadata = null }) => {
  writeAuditLog({
    actor,
    actorRole,
    action,
    targetType: "AuthSecurity",
    targetId: null,
    reason,
    metadata,
  });
};
