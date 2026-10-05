/**
 * P3 — Auth request validators (identity validation seam).
 *
 * Pure functions extracted VERBATIM from authService flows: same status,
 * code, message, and details for every rejection. Services call these
 * instead of inline blocks (single source of truth); controllers call the
 * pre-database subset so malformed requests fail fast with identical bytes
 * (Task 8/9/14). No new rejections are introduced here.
 */
import { normalizeIndianMobile } from "../utils/phoneValidation.js";

export const normalizeRole = (role) => {
  if (!role) return null;
  const normalized = role.toString().trim().toLowerCase();
  if (["owner", "admin", "customer", "technician"].includes(normalized)) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return null;
};

export const normalizeIdentifierOrThrow = (identifier, mobileNumber) => {
  const rawIdentifier = (identifier || "")?.trim();
  const normalized = normalizeIndianMobile(rawIdentifier || mobileNumber);
  if (!normalized) {
    const invalidFormat = Boolean(rawIdentifier);
    const err = new Error(
      invalidFormat
        ? "Invalid mobile number (10 digits, optional +91 prefix)"
        : "Identifier (Mobile Number) required"
    );
    err.statusCode = 400;
    err.code = invalidFormat ? "INVALID_MOBILE_NUMBER" : "VALIDATION_ERROR";
    err.details = { required: ["identifier", "role"] };
    throw err;
  }
  return normalized;
};

export const requireKnownRole = (role) => {
  const normRole = normalizeRole(role);
  if (!normRole) {
    const err = new Error("Identifier and role required");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    err.details = { required: ["identifier", "role"] };
    throw err;
  }
  return normRole;
};

/** P1 closed allowlist: only Customer/Technician/Owner via public signup. */
export const enforcePublicSignupRoles = (normRole) => {
  const PUBLIC_SIGNUP_ROLES = new Set(["Customer", "Technician", "Owner"]);
  if (!PUBLIC_SIGNUP_ROLES.has(normRole)) {
    const err = new Error("Signup is not available for this role");
    err.statusCode = 403;
    err.code = "ROLE_NOT_ALLOWED_FOR_SIGNUP";
    err.details = { role: normRole };
    throw err;
  }
};

export const enforceOwnerInvite = (normRole, inviteCode) => {
  if (normRole === "Owner") {
    const expected = process.env.OWNER_SIGNUP_INVITE_CODE;
    const providedCode = String(inviteCode || "").trim();
    if (!expected || !providedCode || providedCode !== expected) {
      const err = new Error("Owner signup requires a valid invite code");
      err.statusCode = 403;
      err.code = "OWNER_INVITE_REQUIRED";
      throw err;
    }
  }
};

export const enforceTermsForRole = (normRole, termsAndServices, privacyPolicy) => {
  if (normRole === "Customer" || normRole === "Technician") {
    const missing = [];
    if (termsAndServices !== true) missing.push("termsAndServices");
    if (privacyPolicy !== true) missing.push("privacyPolicy");
    if (missing.length > 0) {
      const err = new Error(`You must accept ${missing.join(" and ")} to continue`);
      err.statusCode = 400;
      err.code = "TERMS_OR_PRIVACY_NOT_ACCEPTED";
      err.details = {
        required: ["termsAndServices", "privacyPolicy"],
        message: "Both termsAndServices and privacyPolicy must be true",
      };
      throw err;
    }
  }
};

export const requireOtpPresent = (identifier, mobileNumber, otp) => {
  const finalIdentifier = normalizeIndianMobile((identifier || mobileNumber)?.trim());
  if (!finalIdentifier || !otp) {
    const err = new Error("Identifier and OTP required");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    err.details = { required: ["identifier", "otp"] };
    throw err;
  }
  return finalIdentifier;
};

const INVALID_MOBILE_MESSAGE = "Valid mobile number required (10 digits, optional +91 prefix)";

export const requireResendIdentifier = (identifier, mobileNumber) => {
  const finalIdentifier = normalizeIndianMobile((identifier || mobileNumber)?.trim());
  if (!finalIdentifier) {
    const err = new Error(INVALID_MOBILE_MESSAGE);
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  return finalIdentifier;
};

export const requireLoginIdentifier = (identifier, mobileNumber) => {
  const finalIdentifier = normalizeIndianMobile((identifier || mobileNumber)?.trim());
  if (!finalIdentifier) {
    const err = new Error(INVALID_MOBILE_MESSAGE);
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  return finalIdentifier;
};

/**
 * P5 — refresh-token presence rule. Accepts the canonical `refresh_token`
 * body field (JSON transport shared by mobile + browser clients). Missing
 * or malformed values are 400 here; unknown-but-wellformed values are 401
 * in the service (no session-state oracle).
 */
export const requireRefreshToken = (body) => {
  const raw =
    body?.refresh_token !== undefined ? body.refresh_token : body?.refreshToken;
  if (typeof raw !== "string" || raw.trim().length < 32) {
    const err = new Error("Refresh token required");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    err.details = { required: ["refresh_token"] };
    throw err;
  }
  return raw.trim();
};

export const validateSetPasswordInput = (password) => {
  if (!password) {
    const err = new Error("Password is required");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  if (password.length < 8) {
    const err = new Error("Password must be at least 8 characters long");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
};

export const validateProvisionPassword = (password) => {
  if (!password || String(password).length < 8) {
    const err = new Error("Password must be at least 8 characters");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
};

export const validateAcceptTermsInput = (termsAndServices, privacyPolicy) => {
  const updateData = {};
  if (termsAndServices === true) {
    updateData.termsAndServices = true;
    updateData.termsAndServicesAt = new Date();
  }
  if (privacyPolicy === true) {
    updateData.privacyPolicy = true;
    updateData.privacyPolicyAt = new Date();
  }
  if (Object.keys(updateData).length === 0) {
    const err = new Error("Provide either termsAndServices: true or privacyPolicy: true");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  return updateData;
};
