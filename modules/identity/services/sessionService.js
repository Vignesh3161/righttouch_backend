import mongoose from "mongoose";
import * as sessionRepo from "../repositories/sessionRepository.js";
import * as userRepo from "../repositories/userRepository.js";
import * as profileRepo from "../repositories/profileRepository.js";
import { emitSecurityEvent } from "../utils/securityEvents.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  signSessionAccessToken,
  accessTokenExpiresInSeconds,
  REFRESH_TTL_MS,
} from "../utils/sessionTokens.js";

/**
 * P5 — AuthSession application service.
 *
 * Owns all session business decisions; persistence goes through
 * sessionRepository/userRepository (P3 boundaries). Controllers never
 * touch the AuthSession collection directly.
 *
 * Race safety WITHOUT requiring multi-document transactions (the unit/
 * socket harnesses run on standalone in-memory Mongo): rotation
 * linearizes on the atomic `claimForRotation` findOneAndUpdate
 * ({_id, revokedAt: null} → revoked+replaced). Exactly one concurrent
 * claimer wins; losers observe a superseded row → reuse path.
 */

const invalidRefresh = () => {
  const err = new Error("Invalid refresh token");
  err.statusCode = 401;
  err.code = "REFRESH_INVALID";
  throw err;
};

/**
 * Server-observed device context for session rows. userAgent/ip come from
 * the transport (never trusted for auth); deviceId/platform are accepted
 * only when the client volunteers them (additive, optional).
 */
export const deviceFromRequest = (req) => {
  const body = req?.body && typeof req.body === "object" ? req.body : {};
  const headers = req?.headers || {};
  const forwarded = Array.isArray(headers["x-forwarded-for"])
    ? headers["x-forwarded-for"][0]
    : headers["x-forwarded-for"];
  return {
    userAgent: typeof headers["user-agent"] === "string" ? headers["user-agent"].slice(0, 512) : null,
    ip:
      (typeof forwarded === "string" && forwarded.split(",")[0].trim()) ||
      req?.ip ||
      null,
    deviceId: typeof body.deviceId === "string" ? body.deviceId.slice(0, 128) : null,
    platform: typeof body.platform === "string" ? body.platform.slice(0, 64) : null,
  };
};

const assertAccountCanRefresh = async (user) => {
  if (!user) invalidRefresh();
  if (user.status === "Deleted") {
    const err = new Error("Account deleted");
    err.statusCode = 403;
    err.code = "ACCOUNT_DELETED";
    throw err;
  }
  if (user.status === "Blocked") {
    const err = new Error("Account is blocked. Please contact support.");
    err.statusCode = 403;
    err.code = "ACCOUNT_BLOCKED";
    throw err;
  }
  if (user.status === "Inactive") {
    const err = new Error("This account is inactive. Contact support.");
    err.statusCode = 403;
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  if (user.role === "Technician") {
    const techProfile = await profileRepo.findByUserId(user._id, "workStatus");
    if (techProfile?.workStatus === "deleted") {
      const err = new Error("Account deleted");
      err.statusCode = 403;
      err.code = "ACCOUNT_DELETED";
      throw err;
    }
    if (techProfile?.workStatus === "suspended") {
      const err = new Error("Technician account is suspended. Contact support.");
      err.statusCode = 403;
      err.code = "TECHNICIAN_SUSPENDED";
      throw err;
    }
  }
};

/** Create one device session AFTER successful authentication (never before). */
export const createSession = async ({ userId, role, device = {} }, options = {}) => {
  const rawRefreshToken = generateRefreshToken();
  const now = new Date();
  const docs = await sessionRepo.createSession(
    {
      userId,
      role,
      tokenHash: hashRefreshToken(rawRefreshToken),
      familyId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
      device: {
        userAgent: device.userAgent || null,
        ip: device.ip || null,
        deviceId: device.deviceId || null,
        platform: device.platform || null,
      },
    },
    options
  );
  const session = Array.isArray(docs) ? docs[0] : docs;
  return { session, refreshToken: rawRefreshToken };
};

/** Active-session read for the per-request sid check (null unless usable). */
export const findActiveSessionById = async (sessionId, options = {}) => {
  if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) return null;
  const doc = await sessionRepo.findById(sessionId, options);
  if (!doc || doc.revokedAt || doc.expiresAt <= new Date()) return null;
  return doc;
};

/**
 * One-time-use rotation with mandatory reuse detection.
 * Returns fresh { accessToken, refreshToken, expiresIn, sessionId }.
 */
export const rotateRefreshToken = async ({ refreshToken, device = {} }, options = {}) => {
  if (!refreshToken || typeof refreshToken !== "string") invalidRefresh();
  const now = new Date();
  const presentedHash = hashRefreshToken(refreshToken);
  const oldSession = await sessionRepo.findByTokenHash(presentedHash, options);

  if (!oldSession) invalidRefresh();
  if (oldSession.expiresAt <= now) invalidRefresh();

  // Superseded row presented again → POSSIBLE theft, but only when the
  // replacement row actually exists (rotation fully completed). If the
  // replacement is absent, a concurrent rotation is still in flight and
  // this is a benign double-submit → plain rejection, no family nuke, so
  // the legitimate winner's fresh version/tokens stay valid.
  if (oldSession.revokedAt && oldSession.replacedBySessionId) {
    const replacementExists = await sessionRepo.findById(
      oldSession.replacedBySessionId,
      options
    );
    if (replacementExists) {
      await revokeSessionFamilyInternal(oldSession.familyId, "reuse_detected", options);
      await userRepo.bumpTokenVersion(oldSession.userId, options);
      // P9: refresh reuse is a compromise signal — must be observable.
      emitSecurityEvent({
        actor: oldSession.userId || null,
        actorRole: oldSession.role || null,
        action: "AUTH_REFRESH_REUSE_DETECTED",
      });
    }
    invalidRefresh();
  }
  if (oldSession.revokedAt) invalidRefresh();

  const user = await userRepo.findById(oldSession.userId, options);
  await assertAccountCanRefresh(user);
  if (user.role !== oldSession.role) invalidRefresh();

  // Linearization point FIRST (no orphan rows on any path): claim the
  // old row as rotated, pointing at the not-yet-created replacement id.
  // Exactly one concurrent claimer wins; losers observe a superseded row.
  const rawNewToken = generateRefreshToken();
  const replacementId = new mongoose.Types.ObjectId();
  const claimed = await sessionRepo.claimForRotation(oldSession._id, replacementId, now, options);
  if (!claimed) {
    // Lost the race (or landed after a rotation/logout): re-read to
    // decide reuse-nuke vs plain rejection. Nothing was created, so
    // there is no orphan to clean up. Nuke only when the replacement
    // row exists (completed rotation ⇒ genuine reuse, not an in-flight
    // concurrent duplicate) — this keeps the winner's fresh tokens valid.
    const reread = await sessionRepo.findByTokenHash(presentedHash, options);
    if (reread?.revokedAt && reread?.replacedBySessionId) {
      const replacementExists = await sessionRepo.findById(
        reread.replacedBySessionId,
        options
      );
      if (replacementExists) {
        await revokeSessionFamilyInternal(reread.familyId, "reuse_detected", options);
        await userRepo.bumpTokenVersion(reread.userId, options);
        // P9: same compromise signal as the primary reuse path.
        emitSecurityEvent({
          actor: reread.userId || null,
          actorRole: reread.role || null,
          action: "AUTH_REFRESH_REUSE_DETECTED",
        });
      }
    }
    invalidRefresh();
  }

  // Winner-only: materialize the replacement row in the same family.
  // If this throws after the claim, the old token stays dead (fail-closed;
  // the client re-authenticates) — never a double-valid window.
  await sessionRepo.createSession(
    {
      _id: replacementId,
      userId: user._id,
      role: user.role,
      tokenHash: hashRefreshToken(rawNewToken),
      familyId: oldSession.familyId,
      expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
      device: {
        userAgent: device.userAgent || null,
        ip: device.ip || null,
        deviceId: device.deviceId || null,
        platform: device.platform || null,
      },
    },
    options
  );

  let technicianProfileId = null;
  if (user.role === "Technician") {
    const tech = await profileRepo.findByUserId(user._id, "_id", options);
    technicianProfileId = tech?._id || null;
  }

  const accessToken = signSessionAccessToken({
    userId: user._id,
    role: user.role,
    technicianProfileId,
    tokenVersion: user.tokenVersion ?? 0,
    sid: String(replacementId),
  });

  // P9: rotation is the normal path — logged for anomaly baselining.
  emitSecurityEvent({ actor: user._id || null, actorRole: user.role || null, action: "AUTH_REFRESH_ROTATED" });

  return {
    accessToken,
    refreshToken: rawNewToken,
    expiresIn: accessTokenExpiresInSeconds(),
    sessionId: replacementId,
    userId: user._id,
    role: user.role,
  };
};

/**
 * Logout: revoke ONE session. Idempotent — unknown/already-revoked ids
 * still report success (never leak session existence). The session must
 * belong to the caller; cross-user ids are ignored, never acted on.
 */
export const revokeSession = async ({ userId, sessionId }, options = {}) => {
  const now = new Date();
  if (
    !userId ||
    !sessionId ||
    !mongoose.Types.ObjectId.isValid(sessionId)
  ) {
    return { revoked: false };
  }
  const doc = await sessionRepo.findById(sessionId, options);
  if (!doc || String(doc.userId) !== String(userId)) {
    return { revoked: false };
  }
  if (doc.revokedAt) return { revoked: true };
  await sessionRepo.revokeById(sessionId, "logout", now, options);
  return { revoked: true, sessionId: doc._id };
};

const revokeSessionFamilyInternal = async (familyId, reason, options = {}) => {
  if (!familyId) return { revokedCount: 0 };
  const now = new Date();
  const res = await sessionRepo.revokeFamily(familyId, reason, now, options);
  return { revokedCount: res?.modifiedCount ?? 0 };
};

export const revokeSessionFamily = revokeSessionFamilyInternal;

/**
 * Logout-all: revoke EVERY session for the user, then bump tokenVersion.
 * Order matters (standalone-safe without transactions): sessions die
 * first so a crash can never leave a live refresh token able to mint
 * post-bump access tokens; the bump then kills outstanding access tokens.
 */
export const revokeAllUserSessions = async ({ userId }, options = {}) => {
  const now = new Date();
  const res = await sessionRepo.revokeAllForUser(userId, "logout_all", now, options);
  const version = await userRepo.bumpTokenVersion(userId, options);
  return { revokedCount: res?.modifiedCount ?? 0, tokenVersion: version };
};

/**
 * Global authentication invalidation for security events
 * (logout-all, deletion prep, suspension flows). Same safe ordering as
 * logout-all. Returns the new tokenVersion.
 */
export const invalidateUserAuthentication = async ({ userId, reason = "security" }, options = {}) => {
  const now = new Date();
  await sessionRepo.revokeAllForUser(userId, reason, now, options);
  return userRepo.bumpTokenVersion(userId, options);
};

/** Account-deletion hook: drop every session row for the removed user. */
export const deleteSessionsForUser = async (userId, options = {}) => {
  await sessionRepo.deleteByUserId(userId, options);
  return true;
};

/**
 * Ops cleanup for revoked rows. Steady-state expiry is handled by the
 * expiresAt TTL index; this covers administrative purges.
 */
export const cleanupRevokedSessions = async (olderThanMs = 0, options = {}) => {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await sessionRepo.deleteRevokedBefore(cutoff, options);
  return { deletedCount: res?.deletedCount ?? 0 };
};
