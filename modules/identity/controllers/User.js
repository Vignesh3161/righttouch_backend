import {
  signupAndSendOtpInternal,
  resendOtpInternal,
  verifyOtpInternal,
  setPasswordInternal,
  loginInternal,
  acceptTermsInternal,
  checkUserByIdentifierInternal,
} from "../services/authService.js";

import {
  getMyProfileInternal,
  completeProfileInternal,
  updateMyProfileInternal,
  getAllUsersInternal,
  getUserByIdInternal,
} from "../services/profileService.js";

import { deleteUserByIdInternal, provisionAdminInternal } from "../services/accountService.js";
// P3: request validators run here (Route → validator → controller → service)
// for pre-database input rules. Errors are byte-identical to the service
// errors they precede, so response contracts cannot change (Task 9/14).
import {
  normalizeIdentifierOrThrow,
  requireKnownRole,
  enforcePublicSignupRoles,
  enforceOwnerInvite,
  enforceTermsForRole,
  requireOtpPresent,
  requireResendIdentifier,
  requireLoginIdentifier,
  validateSetPasswordInput,
  validateAcceptTermsInput,
  requireRefreshToken,
} from "../validators/authRequests.js";
import {
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
  deviceFromRequest,
} from "../services/sessionService.js";
import { getIo } from "../../../shared/utils/ioAccess.js";
import {
  revokeSocketsForSession,
  revokeSocketsForUser,
} from "../../../shared/utils/socketSessionControl.js";

/* ======================================================
  RESPONSE HELPERS (Consistent API shape)
====================================================== */
const ok = (res, status, message, result = {}) =>
  res.status(status).json({
    success: true,
    message,
    result,
  });

const fail = (res, status, message, code, details) =>
  res.status(status).json({
    success: false,
    message,
    code,
    details,
  });

/* ======================================================
  ADMIN / USER MANAGEMENT CONTROLLERS
====================================================== */

export const getAllUsers = async (req, res) => {
  try {
    const { role } = req.params;
    const { search } = req.query;

    const users = await getAllUsersInternal({ role, search });
    return res.status(200).json({ success: true, message: "Users fetched", result: users });
  } catch (err) {
    return res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message || "Internal server error", result: {} });
  }
};

export const getUserById = async (req, res) => {
  try {
    const { role, id } = req.params;
    const user = await getUserByIdInternal({ role, id });
    return res.status(200).json({ success: true, message: "User fetched", result: user });
  } catch (err) {
    return res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message || "Internal server error", result: {} });
  }
};

export const deleteUserById = async (req, res) => {
  try {
    const result = await deleteUserByIdInternal({
      adminUser: req.user,
      targetUserId: req.params.id,
    });
    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
      result,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Server error",
      result: { error: err.message },
    });
  }
};

/* ======================================================
   P1 (Task 4): OWNER-ONLY ADMIN PROVISIONING
   Additive endpoint — public Admin signup stays disabled.
   Uses the identity ok/fail envelope; never echoes secrets.
====================================================== */
export const provisionAdmin = async (req, res) => {
  try {
    req.body = req.body || {};
    const { identifier, mobileNumber, password, fname, lname, email } = req.body;

    const result = await provisionAdminInternal({
      ownerUser: req.user,
      identifier,
      mobileNumber,
      password,
      fname,
      lname,
      email,
    });

    return ok(res, 201, "Admin provisioned successfully", result);
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR",
      err.details
    );
  }
};

export const checkUserByIdentifier = async (req, res) => {
  try {
    const { identifier } = req.params;
    const result = await checkUserByIdentifierInternal(identifier);
    return res.status(200).json({
      success: true,
      message: "User found",
      result,
    });
  } catch (err) {
    return res
      .status(err.statusCode || 500)
      .json({ success: false, message: err.message || "Internal server error", result: err.result || {} });
  }
};

/* ======================================================
  AUTHENTICATION & OTP CONTROLLERS
====================================================== */

export const signupAndSendOtp = async (req, res) => {
  try {
    req.body = req.body || {};
    const { identifier, role, termsAndServices, privacyPolicy, inviteCode } = req.body;

    // P3 validation seam: same rules the service enforces first (identical errors).
    normalizeIdentifierOrThrow(identifier, null);
    const normRole = requireKnownRole(role);
    enforcePublicSignupRoles(normRole);
    enforceOwnerInvite(normRole, inviteCode);
    enforceTermsForRole(normRole, termsAndServices, privacyPolicy);

    const result = await signupAndSendOtpInternal({
      identifier,
      role,
      termsAndServices,
      privacyPolicy,
      inviteCode,
    });

    return ok(res, 200, "OTP sent successfully", result);
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR",
      err.details
    );
  }
};

export const resendOtp = async (req, res) => {
  try {
    req.body = req.body || {};
    // P2: role/purpose are additive optional scoping hints (Task 1/4).
    const { identifier, mobileNumber, role, purpose } = req.body;

    // P3 validation seam: identifier rule the service enforces first (identical error).
    requireResendIdentifier(identifier, mobileNumber);

    const result = await resendOtpInternal({ identifier, mobileNumber, role, purpose });
    return ok(res, 200, "OTP resent successfully", result);
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR"
    );
  }
};

export const verifyOtp = async (req, res) => {
  try {
    req.body = req.body || {};
    const { identifier, mobileNumber, otp, role } = req.body;

    // P3 validation seam: presence rule the service enforces first (identical error).
    requireOtpPresent(identifier, mobileNumber, otp);

    // P2 (Task 1/2): server-trusted route scope set by route wrappers via
    // req.otpScope ({role, purpose}); absent on generic routes (legacy).
    // P5: device context travels to session creation (additive, optional).
    const result = await verifyOtpInternal({
      identifier,
      mobileNumber,
      otp,
      role,
      scope: req.otpScope,
      device: deviceFromRequest(req),
    });

    if (result.user && result.token) {
      // SIGNUP completion returns 201, LOGIN returns 200
      const isSignup = result.user.profileComplete === false; // Or signup flag
      const status = isSignup && !result.user.lastLoginAt ? 201 : 200;
      const message = status === 201 ? "Account created successfully" : "Login successful";
      return ok(res, status, message, result);
    }

    return ok(res, 200, "OTP verified successfully", result);
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR",
      err.details
    );
  }
};

export const setPassword = async (req, res) => {
  try {
    req.body = req.body || {};
    const { password } = req.body;
    const userId = req.user?.userId;

    // P3 validation seam (Auth middleware guarantees userId, so the service
    // reaches this same check first — identical error either way).
    validateSetPasswordInput(password);

    await setPasswordInternal({ userId, password });
    return ok(res, 200, "Password set successfully");
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR"
    );
  }
};

export const login = async (req, res, opts = {}) => {
  try {
    req.body = req.body || {};
    const privileged = opts?.privileged === true;
    const { identifier, mobileNumber, role, password } = req.body;

    // P3 validation seam: identifier rule the service enforces first (identical error).
    requireLoginIdentifier(identifier, mobileNumber);

    const result = await loginInternal({
      identifier,
      mobileNumber,
      role,
      password,
      privileged,
      device: deviceFromRequest(req),
    });

    if (result.type === "PASSWORD_LOGIN") {
      return ok(res, 200, "Login successful", {
        token: result.token,
        // P5 additive fields: existing `token` consumers keep working.
        refresh_token: result.refresh_token,
        expires_in: result.expires_in,
        userId: result.userId,
        role: result.role,
      });
    }

    return ok(res, 200, "OTP sent successfully", {
      identifier: result.identifier,
      role: result.role,
      purpose: result.purpose,
      expiresInSeconds: result.expiresInSeconds,
    });
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR",
      err.details
    );
  }
};

/* ======================================================
  ROLE-SPECIFIC LOGIN & OTP WRAPPERS
====================================================== */

export const ownerLogin = async (req, res) => {
  return login(req, res, { privileged: true });
};

export const technicianLogin = async (req, res) => {
  req.body = req.body || {};
  req.body.role = "Technician";
  return login(req, res);
};

export const customerLogin = async (req, res) => {
  req.body = req.body || {};
  req.body.role = "Customer";
  return login(req, res);
};

export const verifyCustomerOtp = async (req, res) => {
  req.body = req.body || {};
  req.body.role = "Customer";
  return verifyOtp(req, res);
};

export const verifyTechnicianOtp = async (req, res) => {
  req.body = req.body || {};
  req.body.role = "Technician";
  return verifyOtp(req, res);
};

export const requestLoginOtp = async (req, res) => {
  return login(req, res);
};

// Unified LOGIN-only verification: purpose is server-derived (the unified
// request endpoint issues LOGIN OTPs exclusively); role narrows from the
// client body when present. Generic /verify-otp keeps legacy behavior.
export const verifyLoginOtp = async (req, res) => {
  req.otpScope = { ...(req.otpScope || {}), purpose: "LOGIN" };
  return verifyOtp(req, res);
};

/* ======================================================
  P5 — PERSISTENT SESSION CONTROLLERS
  Centralized identity routes (no per-role duplicates): refresh is
  public (the refresh token is the credential); logout/logout-all
  derive the user from the verified access token (never from client
  input — no IDOR). Response envelopes follow the identity ok/fail
  shape. Raw refresh tokens are never logged.
===================================================== */

export const refreshSession = async (req, res) => {
  try {
    req.body = req.body || {};
    // P3-style seam first: presence rule (400) before any DB lookup.
    const presented = requireRefreshToken(req.body);
    const result = await rotateRefreshToken({
      refreshToken: presented,
      device: deviceFromRequest(req),
    });
    return ok(res, 200, "Token refreshed successfully", {
      token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: result.expiresIn,
    });
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR",
      err.details
    );
  }
};

export const logout = async (req, res) => {
  try {
    // Legacy tokens carry no sid: still report success without pretending
    // a specific session was revoked.
    const { userId, sid } = req.user || {};
    if (!userId) {
      return fail(res, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const result = await revokeSession({ userId, sessionId: sid });
    if (result.revoked && result.sessionId) {
      revokeSocketsForSession(getIo(), userId, String(result.sessionId));
    }
    return ok(res, 200, "Logged out successfully", { revoked: result.revoked });
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR"
    );
  }
};

export const logoutAll = async (req, res) => {
  try {
    const { userId } = req.user || {};
    if (!userId) {
      return fail(res, 401, "Unauthorized", "UNAUTHORIZED");
    }
    const result = await revokeAllUserSessions({ userId });
    revokeSocketsForUser(getIo(), userId);
    return ok(res, 200, "Logged out from all devices successfully", {
      revokedCount: result.revokedCount,
    });
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR"
    );
  }
};

/* ======================================================
  PROFILE CONTROLLERS
====================================================== */

export const getMyProfile = async (req, res) => {
  try {
    const { userId, role } = req.user || {};
    const result = await getMyProfileInternal({ userId, role });
    return ok(res, 200, "Profile fetched successfully", result);
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR"
    );
  }
};

export const completeProfile = async (req, res) => {
  try {
    const { userId, role } = req.user || {};
    const result = await completeProfileInternal({ userId, role, body: req.body });
    return ok(res, 200, "Profile completed successfully", result);
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR"
    );
  }
};

export const updateMyProfile = async (req, res) => {
  try {
    const { userId, role } = req.user || {};
    const result = await updateMyProfileInternal({ userId, role, body: req.body });
    return ok(res, 200, "Profile updated successfully", result);
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR",
      err.details
    );
  }
};

export const acceptTerms = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { termsAndServices, privacyPolicy } = req.body || {};
    // P3 validation seam (Auth guarantees userId; identical error).
    validateAcceptTermsInput(termsAndServices, privacyPolicy);
    const result = await acceptTermsInternal({ userId, termsAndServices, privacyPolicy });
    return ok(res, 200, "Terms or Privacy Policy updated successfully", result);
  } catch (err) {
    return fail(
      res,
      err.statusCode || 500,
      err.message || "Internal server error",
      err.code || "SERVER_ERROR"
    );
  }
};
