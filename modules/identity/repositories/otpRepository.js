/**
 * P3 — OTP repository (identity-owned persistence seam).
 *
 * Preserves the full P2 security architecture through the abstraction:
 * scoped identity (identifier + role + purpose), verified:false,
 * unexpired lifecycle, and ATOMIC one-time consumption. The repository
 * exposes `consumeOtp` as a single atomic operation — services never touch
 * raw Mongoose update operators for consumption (Task 3).
 *
 * Legacy behavior note: callers that omit role/purpose keep the
 * identifier-only lookup (generic /verify-otp + legacy resend). The seam is
 * shaped so a future phase can delete that fallback without touching
 * scoped flows (Task 15).
 */
import Otp from "../models/Otp.js";

const scopedFilter = ({ identifier, role, purpose }) => {
  const filter = {
    identifier,
    verified: false,
    otp: { $exists: true },
    expiresAt: { $gte: Date.now() },
  };
  if (role) filter.role = role;
  if (purpose) filter.purpose = purpose;
  return filter;
};

/** Newest live OTP for a scoped context (verify + resend share this shape). */
export const findLiveOtp = ({ identifier, role, purpose }, options = {}) => {
  let query = Otp.findOne(scopedFilter({ identifier, role, purpose })).sort({ createdAt: -1 });
  if (options?.session) query = query.session(options.session);
  return query;
};

/**
 * Newest row for a context regardless of verified/expired lifecycle.
 * Used ONLY by resend: its 60s cooldown is row-age based, so the legacy
 * semantics (latest row, then 404 when absent) must be preserved exactly.
 */
export const findLatestOtp = ({ identifier, role, purpose }, options = {}) => {
  const filter = { identifier };
  if (role) filter.role = role;
  if (purpose) filter.purpose = purpose;
  let query = Otp.findOne(filter).sort({ createdAt: -1 });
  if (options?.session) query = query.session(options.session);
  return query;
};

export const recordAttempt = (otpId, options = {}) => {
  let query = Otp.updateOne({ _id: otpId }, { $inc: { attempts: 1 } });
  if (options?.session) query = query.session(options.session);
  return query;
};

/**
 * P9: atomic attempt claim. Increments attempts ONLY when under the
 * budget, in a single findOneAndUpdate — parallel wrong guesses can no
 * longer all pass a read-then-write pre-check. Returns the post-claim
 * document, or null when the budget is exhausted. Serial semantics are
 * identical to recordAttempt-after-check (one increment per try).
 */
export const claimOtpAttempt = (otpId, maxAttempts = 5, options = {}) => {
  let query = Otp.findOneAndUpdate(
    { _id: otpId, attempts: { $lt: maxAttempts } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (options?.session) query = query.session(options.session);
  return query;
};

/**
 * Atomic one-time consume. Succeeds for exactly one concurrent caller;
 * returns the consumed document, or null when already consumed/expired.
 * Budget enforcement lives in claimOtpAttempt (P9): consume MUST NOT
 * re-check attempts, because N parallel legitimate claims land before any
 * consume runs and must still yield exactly one winner. MUST NOT be
 * replaced with read-then-write (P2 Task 3).
 */
export const consumeOtp = (otpId, options = {}) => {
  let query = Otp.findOneAndUpdate(
    { _id: otpId, verified: false, expiresAt: { $gte: Date.now() } },
    { $set: { verified: true } },
    { new: true }
  );
  if (options?.session) query = query.session(options.session);
  return query;
};

/** Issue a fresh OTP row (caller supplies the pre-hashed value). */
export const issueOtp = ({ identifier, role, purpose, otpHash, ttlMs = 5 * 60 * 1000 }, options = {}) => {
  const doc = {
    identifier,
    role,
    purpose,
    otp: otpHash,
    expiresAt: Date.now() + ttlMs,
  };
  return options?.session ? Otp.create([doc], { session: options.session }) : Otp.create(doc);
};

/** Supersede previous rows for a context (existing one-active-OTP behavior). */
export const wipeContextOtps = ({ identifier, role, purpose }, options = {}) => {
  let query = Otp.deleteMany({ identifier, role, purpose });
  if (options?.session) query = query.session(options.session);
  return query;
};

export const deleteOtpById = (otpId, options = {}) => {
  let query = Otp.deleteOne({ _id: otpId });
  if (options?.session) query = query.session(options.session);
  return query;
};

/** Account-deletion purge (all purposes/roles for the identifier). */
export const purgeOtpsByIdentifier = (identifier, options = {}) => {
  let query = Otp.deleteMany({ identifier });
  if (options?.session) query = query.session(options.session);
  return query;
};

export const countLiveOtps = ({ identifier, role, purpose }, options = {}) => {
  let query = Otp.countDocuments(scopedFilter({ identifier, role, purpose }));
  if (options?.session) query = query.session(options.session);
  return query;
};
