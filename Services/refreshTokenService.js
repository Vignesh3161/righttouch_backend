import crypto from "crypto";
import RefreshToken from "../Schemas/RefreshToken.js";
import User from "../Schemas/User.js";

// 90 days sliding by default. Every successful rotation resets the clock.
const REFRESH_TTL_DAYS = Math.max(
  1,
  Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 90
);
export const REFRESH_TOKEN_TTL_MS = REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_SECONDS = Math.floor(REFRESH_TOKEN_TTL_MS / 1000);

// Concurrent tabs/devices can present the same old token within a few
// seconds. Treating that as theft would log an innocent user out, so a short
// family-preserving grace window is allowed before reuse is considered abuse.
const configuredGrace = Number(process.env.REFRESH_REUSE_GRACE_SECONDS);
const REUSE_GRACE_MS =
  (Number.isFinite(configuredGrace) ? Math.max(0, configuredGrace) : 60) *
  1000;

const hashSecret = () =>
  process.env.REFRESH_TOKEN_PEPPER || process.env.JWT_SECRET || "";

export const hashRefreshToken = (rawToken) =>
  crypto.createHmac("sha256", hashSecret()).update(String(rawToken)).digest("hex");

const refreshError = (message, code, statusCode = 401, details) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
};

const normalizeMeta = (meta = {}) => ({
  userAgent: String(meta.userAgent || "").slice(0, 512),
  ip: String(meta.ip || "").slice(0, 128),
});

const assertActiveUser = async (userId, expectedRole) => {
  const user = await User.findById(userId)
    .select("role status tokenVersion")
    .lean();
  if (!user) {
    throw refreshError("Account not found", "ACCOUNT_NOT_FOUND");
  }
  if (user.status === "Deleted") {
    throw refreshError("Account not found", "ACCOUNT_DELETED", 403);
  }
  if (user.status === "Blocked") {
    throw refreshError(
      "This account has been blocked. Contact support.",
      "ACCOUNT_BLOCKED",
      403
    );
  }
  if (expectedRole && user.role !== expectedRole) {
    throw refreshError("Session revoked. Please login again.", "SESSION_REVOKED");
  }
  return user;
};

/**
 * Issues a brand-new refresh token. Pass `familyId` to continue a rotation
 * family, or omit it to start a new device/session family.
 */
export const issueRefreshToken = async ({
  userId,
  role,
  tokenVersion = 0,
  familyId,
  meta = {},
}) => {
  const rawToken = crypto.randomBytes(48).toString("base64url");
  const tokenHash = hashRefreshToken(rawToken);
  const family = familyId || crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const normalizedMeta = normalizeMeta(meta);

  await RefreshToken.create({
    userId,
    role,
    tokenHash,
    familyId: family,
    tokenVersion: Number(tokenVersion) || 0,
    expiresAt,
    userAgent: normalizedMeta.userAgent,
    ip: normalizedMeta.ip,
  });

  return {
    refreshToken: rawToken,
    tokenHash,
    familyId: family,
    expiresAt,
    expiresInSeconds: REFRESH_TOKEN_TTL_SECONDS,
  };
};

const graceIssue = async ({ existing, user, meta }) => {
  const issued = await issueRefreshToken({
    userId: user._id,
    role: user.role,
    tokenVersion: user.tokenVersion ?? 0,
    familyId: existing.familyId,
    meta,
  });
  await RefreshToken.updateOne(
    { _id: existing._id },
    { $set: { replacedBy: issued.tokenHash } }
  ).catch(() => {});
  return {
    user,
    ...issued,
    tokenVersion: user.tokenVersion ?? 0,
  };
};

const isGraceReuse = (doc, now) =>
  Boolean(
    doc?.revokedAt &&
      doc.revokedReason === "rotated" &&
      now.getTime() - new Date(doc.revokedAt).getTime() <= REUSE_GRACE_MS
  );

/**
 * Validates + rotates a refresh token. The old token is consumed atomically;
 * a concurrent duplicate within the grace window gets its own new token in the
 * same family, while a later reuse revokes the whole family.
 */
export const rotateRefreshToken = async ({ rawToken, meta = {} }) => {
  if (!rawToken || typeof rawToken !== "string") {
    throw refreshError("Refresh token required", "REFRESH_TOKEN_REQUIRED", 400);
  }

  const now = new Date();
  const existing = await RefreshToken.findOne({
    tokenHash: hashRefreshToken(rawToken),
  });

  if (!existing) {
    throw refreshError("Invalid refresh token", "INVALID_REFRESH_TOKEN");
  }

  if (existing.expiresAt.getTime() <= now.getTime()) {
    await RefreshToken.updateOne(
      { _id: existing._id, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: "expired" } }
    ).catch(() => {});
    throw refreshError("Refresh token expired", "REFRESH_TOKEN_EXPIRED");
  }

  const user = await assertActiveUser(existing.userId, existing.role);

  if ((user.tokenVersion ?? 0) !== (existing.tokenVersion ?? 0)) {
    await revokeFamily(existing.familyId, "session_revoked");
    throw refreshError("Session revoked. Please login again.", "SESSION_REVOKED");
  }

  if (existing.revokedAt) {
    if (isGraceReuse(existing, now)) {
      return graceIssue({ existing, user, meta });
    }
    await revokeFamily(existing.familyId, "reuse_detected");
    throw refreshError(
      "Refresh token already used. Please login again.",
      "REFRESH_TOKEN_REUSED"
    );
  }

  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: existing._id, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: "rotated" } },
    { new: true }
  );

  if (!claimed) {
    const fresh = await RefreshToken.findById(existing._id);
    if (isGraceReuse(fresh, now)) {
      return graceIssue({ existing: fresh, user, meta });
    }
    await revokeFamily(existing.familyId, "reuse_detected");
    throw refreshError(
      "Refresh token already used. Please login again.",
      "REFRESH_TOKEN_REUSED"
    );
  }

  const issued = await issueRefreshToken({
    userId: user._id,
    role: user.role,
    tokenVersion: user.tokenVersion ?? 0,
    familyId: claimed.familyId,
    meta,
  });

  await RefreshToken.updateOne(
    { _id: claimed._id },
    { $set: { replacedBy: issued.tokenHash } }
  );

  return {
    user,
    ...issued,
    tokenVersion: user.tokenVersion ?? 0,
  };
};

export const revokeFamily = async (familyId, reason = "revoked") => {
  if (!familyId) return 0;
  const res = await RefreshToken.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return res.modifiedCount || 0;
};

/**
 * Revokes the family that owns a presented refresh token. Used by logout so
 * sending any token from the current device kills its whole rotation chain.
 */
export const revokeRefreshTokenFamily = async (
  rawToken,
  reason = "logout"
) => {
  if (!rawToken || typeof rawToken !== "string") return 0;
  const doc = await RefreshToken.findOne({
    tokenHash: hashRefreshToken(rawToken),
  })
    .select("familyId")
    .lean();
  if (!doc) return 0;
  return revokeFamily(doc.familyId, reason);
};

export const revokeFamilyBySid = async ({ userId, sid, reason = "logout" }) => {
  if (!userId || !sid) return 0;
  const res = await RefreshToken.updateMany(
    { userId, familyId: sid, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return res.modifiedCount || 0;
};

export const revokeAllForUser = async (userId, reason = "revoked") => {
  if (!userId) return 0;
  const res = await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return res.modifiedCount || 0;
};

/**
 * Revokes only tokens older than the caller's current generation. Used after
 * a technician login bump so a losing concurrent login cannot revoke the
 * winner's newer refresh token.
 */
export const revokeStaleForUser = async (
  userId,
  maxTokenVersion,
  reason = "session_replaced"
) => {
  if (!userId) return 0;
  const res = await RefreshToken.updateMany(
    {
      userId,
      revokedAt: null,
      tokenVersion: { $lt: Number(maxTokenVersion) || 0 },
    },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return res.modifiedCount || 0;
};
