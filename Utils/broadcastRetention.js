/**
 * TechnicianBroadcast retention policy.
 *
 * Offers are operational data: keep sent/expired rows briefly for client
 * diagnostics. Accept/reject decisions are audit data: keep them long enough
 * for dispute review. A TTL index on `purgeAt` enforces the policy; the old
 * index on `expiresAt` MUST be removed in production (expiresAt is business
 * state, not retention).
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const daysFromEnv = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

export const BROADCAST_OFFER_RETENTION_DAYS = daysFromEnv("BROADCAST_OFFER_RETENTION_DAYS", 7);
export const BROADCAST_AUDIT_RETENTION_DAYS = daysFromEnv("BROADCAST_AUDIT_RETENTION_DAYS", 90);

export const offerPurgeAt = (expiresAt = new Date(Date.now() + 60 * 60 * 1000)) => {
  const base = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return new Date((Number.isFinite(base) ? base : Date.now()) + BROADCAST_OFFER_RETENTION_DAYS * DAY_MS);
};

export const auditPurgeAt = (from = Date.now()) => {
  const base = from instanceof Date ? from.getTime() : Number(from);
  return new Date((Number.isFinite(base) ? base : Date.now()) + BROADCAST_AUDIT_RETENTION_DAYS * DAY_MS);
};
