import { findAuthSubjectById } from "../../modules/identity/repositories/userRepository.js";
import { findById as findProfileById, findByUserId as findProfileByUserId } from "../../modules/identity/repositories/profileRepository.js";
import { findActiveSessionById } from "../../modules/identity/services/sessionService.js";

/**
 * Shared auth-subject resolver — single source of truth for BOTH
 * HTTP (`Auth`) and Socket.IO (`socketAuth`) gates.
 *
 * Previously the two middlewares duplicated ~40 lines of DB checks and
 * drifted apart (socketAuth validated profile ownership, Auth did not).
 * All status/role/revocation policy lives here now.
 *
 * Policy enforced:
 *  - Subject must exist and not be Deleted/Blocked/Inactive.
 *  - Token role must equal the DB role (case-insensitive). Role is
 *    immutable, so a mismatch means a stale token → force re-login.
 *  - `tokenVersion` revocation is enforced ONLY when both the token and
 *    the user doc carry it. Tokens issued before `tokenVersion` existed
 *    (and users not yet backfilled) pass this check — the compat window
 *    closes itself once the schema + signer both emit the field, with
 *    zero middleware changes required.
 *  - P5: tokens carrying `sid` must resolve to a live, unrevoked,
 *    unexpired AuthSession owned by the same user (immediate logout).
 *    Tokens without `sid` (pre-P5) skip this lookup entirely.
 *  - Technicians: profile is resolved by owner (never trusted blindly
 *    from the token), and `deleted`/`suspended` workStatus is rejected.
 */
export class AuthSubjectError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const TECH_SELECT = "_id workStatus userId";

export const resolveAuthSubject = async (decoded) => {
  if (!decoded?.userId) {
    throw new AuthSubjectError("NO_SUBJECT", 401, "Unauthorized");
  }

  // P3: subject reads via the repositories (same selects/shapes).
  const user = await findAuthSubjectById(decoded.userId);

  if (!user) {
    throw new AuthSubjectError("ACCOUNT_NOT_FOUND", 401, "Account not found");
  }

  if (user.status === "Deleted") {
    // Deliberately 403 + "not found" wording: matches existing client contract.
    throw new AuthSubjectError("ACCOUNT_DELETED", 403, "User not found");
  }

  if (user.status === "Blocked") {
    throw new AuthSubjectError(
      "ACCOUNT_BLOCKED",
      403,
      "This account has been blocked. Contact support."
    );
  }

  if (user.status === "Inactive") {
    throw new AuthSubjectError(
      "ACCOUNT_INACTIVE",
      403,
      "This account is inactive. Contact support."
    );
  }

  // Stale-role trust fix: the DB role wins. (Compared case-insensitively
  // because historical tokens may carry non-normalized casing.)
  if (
    decoded.role &&
    user.role &&
    String(decoded.role).toLowerCase() !== String(user.role).toLowerCase()
  ) {
    throw new AuthSubjectError(
      "SESSION_ROLE_MISMATCH",
      403,
      "Session role changed. Please log in again."
    );
  }

  // Revocation: enforced only when both sides carry a version (compat window).
  if (
    decoded.tokenVersion != null &&
    user.tokenVersion != null &&
    decoded.tokenVersion !== user.tokenVersion
  ) {
    throw new AuthSubjectError(
      "SESSION_REVOKED",
      401,
      "Session revoked. Please log in again."
    );
  }

  // P5 — immediate per-session logout: session-aware access tokens (those
  // carrying `sid`) must resolve to a live AuthSession owned by the same
  // user. Legacy tokens without `sid` keep the compat path (zero extra
  // queries), so pre-P5 clients are unaffected. This is the one bounded
  // per-request lookup P5 adds, and only for new tokens.
  let verifiedSid = null;
  if (decoded.sid !== undefined && decoded.sid !== null) {
    const liveSession = await findActiveSessionById(decoded.sid);
    if (
      !liveSession ||
      String(liveSession.userId) !== String(decoded.userId) ||
      (decoded.role &&
        user.role &&
        String(liveSession.role).toLowerCase() !== String(user.role).toLowerCase())
    ) {
      throw new AuthSubjectError(
        "SESSION_REVOKED",
        401,
        "Session revoked. Please log in again."
      );
    }
    verifiedSid = liveSession._id;
  }

  let resolvedTechProfileId = decoded.technicianProfileId || null;

  if (user.role === "Technician") {
    let techProfile = resolvedTechProfileId
      ? await findProfileById(resolvedTechProfileId, TECH_SELECT, { lean: true })
      : null;

    // Never trust a token-held profile id blindly: it must belong to the
    // token owner. On mismatch (or absence) self-heal by owner lookup.
    if (!techProfile || String(techProfile.userId) !== String(decoded.userId)) {
      techProfile = await findProfileByUserId(decoded.userId, TECH_SELECT, { lean: true });
    }

    if (techProfile) {
      resolvedTechProfileId = techProfile._id;
      if (techProfile.workStatus === "deleted") {
        throw new AuthSubjectError("TECHNICIAN_DELETED", 403, "User not found");
      }
      if (techProfile.workStatus === "suspended") {
        throw new AuthSubjectError(
          "TECHNICIAN_SUSPENDED",
          403,
          "Technician account is suspended. Contact support."
        );
      }
    } else {
      resolvedTechProfileId = null;
    }
  }

  return {
    _id: decoded.userId,
    userId: decoded.userId,
    // DB role wins over the token claim (stale-role fix propagates downstream).
    role: user.role,
    email: decoded.email,
    technicianProfileId: resolvedTechProfileId,
    // P5: verified session id for session-aware tokens; null for legacy
    // tokens (logout stays compat-successful without pretending revocation).
    sid: verifiedSid ? String(verifiedSid) : null,
  };
};
