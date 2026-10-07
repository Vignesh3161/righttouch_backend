/**
 * P3 — Profile repository (identity-side seam over TechnicianProfile).
 *
 * Covers ONLY the TechnicianProfile persistence performed by identity flows
 * (signup creation, account deletion, profile reads/writes, auth-policy
 * lookups). Technician-module business logic keeps its own access; this seam
 * exists so identity services stop constructing Mongoose queries inline.
 * No profileComplete semantics change (P4 owns that).
 */
import TechnicianProfile from "../../technician/models/TechnicianProfile.js";

const withSession = (options, query) =>
  options?.session ? query.session(options.session) : query;

/** Signup-TXN shell (identity creates the pending profile with the User). */
export const createTechnicianShell = (doc, options = {}) =>
  options?.session
    ? TechnicianProfile.create([doc], { session: options.session })
    : TechnicianProfile.create(doc);

export const findByUserId = (userId, select, options = {}) => {
  let query = TechnicianProfile.findOne({ userId });
  if (select) query = query.select(select);
  if (options?.lean) query = query.lean();
  return withSession(options, query);
};

export const findById = (profileId, select, options = {}) => {
  let query = TechnicianProfile.findById(profileId);
  if (select) query = query.select(select);
  if (options?.lean) query = query.lean();
  return withSession(options, query);
};

export const updateByUserId = (userId, update, mongoOptions = {}, options = {}) => {
  let query = TechnicianProfile.findOneAndUpdate({ userId }, update, mongoOptions);
  if (options?.select) query = query.select(options.select);
  return withSession(options, query);
};

export const deleteById = (profileId, options = {}) =>
  withSession(options, TechnicianProfile.deleteOne({ _id: profileId }));

/** Profile read with owner-user hydration (GET /me technician shape). */
export const findTechnicianWithUser = (userId, options = {}) =>
  withSession(
    options,
    TechnicianProfile.findOne({ userId })
      .populate({ path: "userId", select: "fname lname gender mobileNumber email" })
      .select("-password")
  );

/** P7 transition dual-write (DEPRECATED — DeviceToken is canonical;
 * removal is Stage G, gated on sustained zero legacyFallbackSends). */
export const addFcmMirror = (userId, fcmToken) =>
  TechnicianProfile.updateOne({ userId }, { $addToSet: { fcmTokens: fcmToken } }).catch(() => {});

export const pullFcmMirror = (userId, pull) =>
  TechnicianProfile.updateOne({ userId }, { $pull: pull }).catch(() => {});
