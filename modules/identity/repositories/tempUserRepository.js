/**
 * P3 — TempUser repository (identity-owned persistence seam).
 *
 * Centralizes temporary-signup-record persistence with the P2 expiry rules:
 * retrieval is expiry-aware (expiresAt, falling back to createdAt + 24h for
 * pre-P2 rows), so expired records are never usable for verification even
 * before MongoDB's asynchronous TTL sweeper removes them (Task 4/6).
 */
import TempUser from "../models/TempUser.js";

export const TEMPUSER_TTL_MS = 24 * 60 * 60 * 1000;

export const isTempUserExpired = (tempUser, now = Date.now()) => {
  if (!tempUser) return true;
  const expiry = tempUser.expiresAt
    ? new Date(tempUser.expiresAt).getTime()
    : new Date(tempUser.createdAt).getTime() + TEMPUSER_TTL_MS;
  return now > expiry;
};

/** Upsert the staging row and refresh its 24h lifetime. */
export const stageSignup = (updateFields, options = {}) => {
  let query = TempUser.findOneAndUpdate(
    { identifier: updateFields.identifier, role: updateFields.role },
    updateFields,
    { upsert: true, new: true }
  );
  if (options?.session) query = query.session(options.session);
  return query;
};

/** Expiry-aware retrieval: expired rows behave as absent. */
export const findLiveSignup = async ({ identifier, role }, options = {}) => {
  let query = TempUser.findOne({ identifier, role });
  if (options?.session) query = query.session(options.session);
  const tempUser = await query;
  if (!tempUser || isTempUserExpired(tempUser)) return null;
  return tempUser;
};

/** Raw retrieval (tests/migrations only — bypasses the expiry guard). */
export const findSignupRaw = ({ identifier, role }, options = {}) => {
  let query = TempUser.findOne({ identifier, role });
  if (options?.session) query = query.session(options.session);
  return query;
};

export const deleteSignup = ({ identifier, role }, options = {}) => {
  let query = TempUser.deleteOne({ identifier, role });
  if (options?.session) query = query.session(options.session);
  return query;
};

/** Account-deletion purge (all roles for the identifier). */
export const purgeSignupsByIdentifier = (identifier, options = {}) => {
  let query = TempUser.deleteMany({ identifier });
  if (options?.session) query = query.session(options.session);
  return query;
};
