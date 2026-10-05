/**
 * P5 — AuthSession repository (identity-owned persistence seam).
 *
 * Centralizes every AuthSession-collection operation. Mongoose specifics
 * (model, atomic claim filters, sessions) stay here; services express
 * intent through application-oriented operations. Follows the P3
 * repository conventions: `withSession` options bag, service-owned
 * transaction boundaries.
 */
import AuthSession from "../models/AuthSession.js";

const withSession = (options, query) =>
  options?.session ? query.session(options.session) : query;

export const createSession = (doc, options = {}) =>
  options?.session
    ? AuthSession.create([doc], { session: options.session })
    : AuthSession.create(doc);

export const findByTokenHash = (tokenHash, options = {}) =>
  withSession(options, AuthSession.findOne({ tokenHash }));

export const findById = (sessionId, options = {}) =>
  withSession(options, AuthSession.findById(sessionId));

/**
 * Atomic rotation claim: marks the session rotated ONLY if it is still
 * unrevoked. Returns the claimed doc, or null if already revoked/expired-
 * claimed — the single primitive that makes concurrent double-refresh
 * race-safe (exactly one claimer wins).
 */
export const claimForRotation = (sessionId, replacementId, now, options = {}) =>
  withSession(
    options,
    AuthSession.findOneAndUpdate(
      { _id: sessionId, revokedAt: null },
      {
        $set: {
          revokedAt: now,
          revokeReason: "rotated",
          replacedBySessionId: replacementId,
          lastUsedAt: now,
        },
      },
      { new: true }
    )
  );

export const linkReplacement = (sessionId, replacementId, options = {}) =>
  withSession(
    options,
    AuthSession.updateOne(
      { _id: sessionId },
      { $set: { replacedBySessionId: replacementId } }
    )
  );

export const revokeById = (sessionId, reason, now, options = {}) =>
  withSession(
    options,
    AuthSession.updateOne(
      { _id: sessionId, revokedAt: null },
      { $set: { revokedAt: now, revokeReason: reason } }
    )
  );

export const revokeAllForUser = (userId, reason, now, options = {}) =>
  withSession(
    options,
    AuthSession.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: now, revokeReason: reason } }
    )
  );

export const revokeFamily = (familyId, reason, now, options = {}) =>
  withSession(
    options,
    AuthSession.updateMany(
      { familyId, revokedAt: null },
      { $set: { revokedAt: now, revokeReason: reason } }
    )
  );

export const countActiveForUser = (userId, now, options = {}) =>
  withSession(
    options,
    AuthSession.countDocuments({ userId, revokedAt: null, expiresAt: { $gt: now } })
  );

export const deleteByUserId = (userId, options = {}) =>
  withSession(options, AuthSession.deleteMany({ userId }));

/** Remove one orphaned session row (race-loser cleanup). */
export const deleteById = (sessionId, options = {}) =>
  withSession(options, AuthSession.deleteOne({ _id: sessionId }));

/** Administrative purge of revoked rows older than the cutoff. */
export const deleteRevokedBefore = (cutoff, options = {}) =>
  withSession(
    options,
    AuthSession.deleteMany({ revokedAt: { $ne: null, $lt: cutoff } })
  );
