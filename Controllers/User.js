import {
  signupAndSendOtpInternal,
  resendOtpInternal,
  verifyOtpInternal,
  setPasswordInternal,
  loginInternal,
  acceptTermsInternal,
  checkUserByIdentifierInternal,
} from "../Services/authService.js";

import {
  getMyProfileInternal,
  completeProfileInternal,
  updateMyProfileInternal,
  getAllUsersInternal,
  getUserByIdInternal,
} from "../Services/profileService.js";

import { deleteUserByIdInternal } from "../Services/accountService.js";

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
    const { identifier, mobileNumber } = req.body;

    const result = await resendOtpInternal({ identifier, mobileNumber });
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

    const result = await verifyOtpInternal({ identifier, mobileNumber, otp, role });

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

    const result = await loginInternal({
      identifier,
      mobileNumber,
      role,
      password,
      privileged,
    });

    if (result.type === "PASSWORD_LOGIN") {
      return ok(res, 200, "Login successful", {
        token: result.token,
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

export const verifyLoginOtp = async (req, res) => {
  return verifyOtp(req, res);
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
