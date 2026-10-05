/**
 * P4 — Canonical profile-completion computation (identity domain).
 *
 * Single source of truth for `profileComplete` semantics. Extracted VERBATIM
 * from the pre-P4 divergent writers (no new mandatory fields):
 *
 * - Technician (from technician.js createTechnician — the strictest writer):
 *   User fname + lname (trimmed, non-empty) AND TechnicianProfile address,
 *   city, specialization, locality (trimmed, non-empty) AND skills (non-empty
 *   array). The updateTechnician writer omitted the name check (tech-side
 *   only); the canonical form includes it — for all persisted complete
 *   profiles the name is present, so stored `true` values are unchanged.
 * - Customer (from profileService.updateMyProfileInternal PUT /me):
 *   User fname (trimmed, non-empty) AND mobileNumber present (schema-required).
 *   complete-profile callers supply fname, so forced-`true` outcomes are
 *   preserved via computation.
 *
 * Pure function: no Express req/res, no DB writes. Callers pass already-loaded
 * user/profile data. `null`, `undefined`/missing, `""`, `[]` stay distinct —
 * only trimmed-non-empty strings and non-empty arrays count.
 */

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

const isNonEmptyArray = (v) => Array.isArray(v) && v.length > 0;

/** Customer heuristic: fname present + mobileNumber present. */
export const isCustomerProfileComplete = (user) => {
  if (!user || typeof user !== "object") return false;
  return Boolean(
    isNonEmptyString(user.fname) &&
      user.mobileNumber !== undefined &&
      user.mobileNumber !== null &&
      String(user.mobileNumber).trim().length > 0
  );
};

/**
 * Technician heuristic: User name + TechnicianProfile fields.
 * Accepts plain objects, Mongoose docs, or lean results.
 */
export const isTechnicianProfileComplete = ({ user, technicianProfile } = {}) => {
  const tech = technicianProfile || {};
  const hasCompleteName = isNonEmptyString(user?.fname) && isNonEmptyString(user?.lname);
  return Boolean(
    hasCompleteName &&
      isNonEmptyString(tech.address) &&
      isNonEmptyString(tech.city) &&
      isNonEmptyString(tech.specialization) &&
      isNonEmptyString(tech.locality) &&
      isNonEmptyArray(tech.skills)
  );
};

/**
 * Canonical entry point. Role-aware:
 * - Technician role OR a technicianProfile passed → technician heuristic.
 * - Otherwise → customer heuristic.
 */
export const computeProfileComplete = ({ role, user, technicianProfile } = {}) => {
  if (role === "Technician" || technicianProfile !== undefined) {
    return isTechnicianProfileComplete({ user, technicianProfile });
  }
  return isCustomerProfileComplete(user);
};

export default computeProfileComplete;
