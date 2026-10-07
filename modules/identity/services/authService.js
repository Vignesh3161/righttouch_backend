import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import sendSms from "../../notifications/utils/sendSMS.js";
import { broadcastAdminUnreadCounts } from "../../notifications/controllers/adminNotificationController.js";
import { getIo } from "../../../shared/utils/ioAccess.js";
// P3 seams: persistence via repositories, input rules via validators.
// normalizeRole lives in the validator module (single source of truth).
import {
  normalizeRole,
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
} from "../validators/authRequests.js";
import * as userRepo from "../repositories/userRepository.js";
import * as otpRepo from "../repositories/otpRepository.js";
import * as tempUserRepo from "../repositories/tempUserRepository.js";
import * as profileRepo from "../repositories/profileRepository.js";
import { createSession } from "./sessionService.js";
import {
  signSessionAccessToken,
  accessTokenExpiresInSeconds,
} from "../utils/sessionTokens.js";
// NOTE: signToken no longer used here — all issuance goes through
// signSessionAccessToken (sid + tokenVersion claims). The base signer
// remains the single JWT primitive in ../utils/token.js.

/**
 * Internal Auth Service
 * Encapsulates authentication, OTP handling, JWT issuance, and login/signup business logic.
 */

// Generate a cryptographically secure 4-digit OTP
export const generateSecureOtp = () => {
  return crypto.randomInt(1000, 10000).toString();
};

// P1 (BREAKING-1 fix): privileged roles can NEVER be created through the
// public signup/verify endpoints. Closed allowlist — any future privileged
// role added to normalizeRole is denied by default until explicitly
// provisioned through the Owner-only provisioning flow.
const PUBLIC_SIGNUP_ROLES = new Set(["Customer", "Technician", "Owner"]);

/**
 * Handles user signup and OTP dispatch.
 */
export const signupAndSendOtpInternal = async ({ identifier, role, termsAndServices, privacyPolicy, inviteCode }) => {
  // P3: input rules via the validation seam (byte-identical errors).
  const normalizedIdentifier = normalizeIdentifierOrThrow(identifier, null);
  const normRole = requireKnownRole(role);
  enforcePublicSignupRoles(normRole);
  enforceOwnerInvite(normRole, inviteCode);
  enforceTermsForRole(normRole, termsAndServices, privacyPolicy);

  // Check duplicate active user
  const existingUser = await userRepo.findDuplicateByIdentifier(normalizedIdentifier);
  if (existingUser) {
    if (existingUser.status === "Deleted") {
      // Anonymize zombie deleted user to free the mobile number
      await userRepo.anonymizeDeletedUser(existingUser._id);
    } else {
      // P2 (Task 8): generalized message, no role oracle (409 + code kept).
      // identifier is client-supplied and retained for UX.
      const message =
        "Mobile number already registered. Please login with your existing account.";
      const err = new Error(message);
      err.statusCode = 409;
      err.code = "MOBILE_ALREADY_EXISTS";
      err.details = { identifier: normalizedIdentifier };
      throw err;
    }
  }

  // Create / update temp user
  const updateFields = {
    identifier: normalizedIdentifier,
    role: normRole,
    tempstatus: "Pending",
    // P2 (Task 6): refresh the 24h temporary lifetime on every signup OTP.
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
  if (termsAndServices === true) {
    updateFields.termsAndServices = true;
    updateFields.termsAndServicesAt = new Date();
  }
  if (privacyPolicy === true) {
    updateFields.privacyPolicy = true;
    updateFields.privacyPolicyAt = new Date();
  }

  const tempUser = await tempUserRepo.stageSignup(updateFields);

  if (!tempUser) {
    const err = new Error("Failed to create signup record");
    err.statusCode = 500;
    err.code = "TEMPUSER_CREATE_FAILED";
    throw err;
  }

  // Clean old SIGNUP OTPs
  await otpRepo.wipeContextOtps({
    identifier: normalizedIdentifier,
    role: normRole,
    purpose: "SIGNUP",
  });

  // Generate CSPRNG OTP
  const otp = generateSecureOtp();
  const hashedOtp = await bcrypt.hash(otp, 10);

  // Store OTP
  await otpRepo.issueOtp({
    identifier: normalizedIdentifier,
    role: normRole,
    purpose: "SIGNUP",
    otpHash: hashedOtp,
  });

  // Send SMS
  try {
    await sendSms(normalizedIdentifier, otp);
  } catch (smsErr) {
    const err = new Error("Failed to send OTP. Please try again.");
    err.statusCode = 500;
    err.code = "SMS_SEND_FAILED";
    throw err;
  }

  return {
    identifier: normalizedIdentifier,
    role: normRole,
    purpose: "SIGNUP",
    expiresInSeconds: 300,
  };
};

/**
 * Resends OTP with 60-second cooldown check.
 */
export const resendOtpInternal = async ({ identifier, mobileNumber, role, purpose }) => {
  // P3: input rule via the validation seam (byte-identical error).
  const finalIdentifier = requireResendIdentifier(identifier, mobileNumber);

  // P2 (Task 1/4): when the caller supplies role/purpose (additive optional
  // fields), cooldown + reissue are scoped to that exact triple so a resend
  // for one context can never wipe or observe another context's OTP.
  // Without them, the legacy identifier-only behavior is preserved.
  const scopedRole = normalizeRole(role);
  const scopedPurpose = ["SIGNUP", "LOGIN"].includes(purpose) ? purpose : null;

  const lastOtp = await otpRepo.findLatestOtp({
    identifier: finalIdentifier,
    role: scopedRole,
    purpose: scopedPurpose,
  });
  if (!lastOtp) {
    const err = new Error("No recent OTP found. Please login or signup again.");
    err.statusCode = 404;
    err.code = "OTP_NOT_FOUND";
    throw err;
  }

  // 60s cooldown check
  if (Date.now() - new Date(lastOtp.createdAt).getTime() < 60 * 1000) {
    const err = new Error("Please wait before retrying");
    err.statusCode = 429;
    err.code = "OTP_COOLDOWN";
    throw err;
  }

  const { role: rowRole, purpose: rowPurpose } = lastOtp;
  if (rowRole === "Owner" && rowPurpose !== "SIGNUP") {
    const err = new Error("Owner can only resend OTP for signup");
    err.statusCode = 403;
    err.code = "FORBIDDEN";
    throw err;
  }

  await otpRepo.wipeContextOtps({ identifier: finalIdentifier, role: rowRole, purpose: rowPurpose });

  const otp = generateSecureOtp();
  const hashedOtp = await bcrypt.hash(otp, 10);

  await otpRepo.issueOtp({
    identifier: finalIdentifier,
    role: rowRole,
    purpose: rowPurpose,
    otpHash: hashedOtp,
  });

  try {
    await sendSms(finalIdentifier, otp);
  } catch (smsErr) {
    const err = new Error("Failed to send OTP. Please try again.");
    err.statusCode = 500;
    err.code = "SMS_SEND_FAILED";
    throw err;
  }

  return {
    identifier: finalIdentifier,
    role,
    purpose,
    expiresInSeconds: 300,
    cooldownSeconds: 60,
  };
};

/**
 * Verifies OTP for SIGNUP or LOGIN in a transaction-safe manner.
 */
export const verifyOtpInternal = async ({ identifier, mobileNumber, otp, role, scope = {}, device = {} }) => {
  // P3: presence rule via the validation seam (byte-identical error).
  const finalIdentifier = requireOtpPresent(identifier, mobileNumber, otp);

  // P2 (Task 1/2): scope the OTP identity by authentication context.
  // Route-derived scope (server-trusted) wins; otherwise the client-supplied
  // role narrows the lookup when present; the generic legacy path (no scope,
  // no role) keeps identifier-only behavior so existing generic clients keep
  // working. Purpose is scoped ONLY from server-trusted route context —
  // never from the client — so a signup OTP can never satisfy a scoped login
  // endpoint and vice versa.
  const scopedRole = normalizeRole(scope.role) || normalizeRole(role);
  const scopedPurpose = ["SIGNUP", "LOGIN"].includes(scope.purpose) ? scope.purpose : null;

  const record = await otpRepo.findLiveOtp({
    identifier: finalIdentifier,
    role: scopedRole,
    purpose: scopedPurpose,
  });
  if (!record) {
    const err = new Error("OTP expired, invalid, or already used");
    err.statusCode = 400;
    err.code = "OTP_INVALID_OR_EXPIRED";
    throw err;
  }

  // P9: atomic attempt claim (replaces read-then-write pre-check).
  // Exactly 5 claims succeed per OTP row, even under concurrency; the
  // 6th and later fail here with the same 429 as before.
  const claimed = await otpRepo.claimOtpAttempt(record._id);
  if (!claimed) {
    const err = new Error("Too many attempts. Request new OTP.");
    err.statusCode = 429;
    err.code = "OTP_TOO_MANY_ATTEMPTS";
    throw err;
  }

  const isMatch = await bcrypt.compare(otp, claimed.otp);
  if (!isMatch) {
    const remainingAttempts = Math.max(0, 5 - claimed.attempts);
    const err = new Error(`Invalid OTP. ${remainingAttempts} attempts remaining`);
    err.statusCode = 400;
    err.code = "OTP_INVALID";
    err.details = { attemptsRemaining: remainingAttempts };
    throw err;
  }

  // P2 (Task 3) via the OTP repository: atomic one-time consume. The
  // conditional findOneAndUpdate succeeds for exactly one concurrent
  // winner; losers receive the standard already-used failure.
  const consumed = await otpRepo.consumeOtp(record._id);
  if (!consumed) {
    const err = new Error("OTP expired, invalid, or already used");
    err.statusCode = 400;
    err.code = "OTP_INVALID_OR_EXPIRED";
    throw err;
  }

  if (record.purpose === "SIGNUP") {
    // P3: expiry-aware retrieval via the TempUser repository (P2 guard
    // preserved: expired rows behave as absent with the same 404).
    const tempUser = await tempUserRepo.findLiveSignup({
      identifier: finalIdentifier,
      role: record.role,
    });
    if (!tempUser) {
      const err = new Error("No signup request found. Please signup first.");
      err.statusCode = 404;
      err.code = "TEMPUSER_NOT_FOUND";
      throw err;
    }

    // P1 (BREAKING-1 defense-in-depth): even if a privileged-role TempUser
    // row predates the signup gate (stale rows have no TTL), verification
    // can never mint a privileged account through this public path.
    // Owner accounts are invite-gated at signup; Admin accounts are
    // Owner-provisioned only.
    if (!PUBLIC_SIGNUP_ROLES.has(record.role)) {
      const err = new Error("Signup is not available for this role");
      err.statusCode = 403;
      err.code = "ROLE_NOT_ALLOWED_FOR_SIGNUP";
      err.details = { role: record.role };
      throw err;
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      // P3: persistence via repositories with the TXN session passed
      // through (service owns the transaction boundary — Task 11).
      const userDoc = await userRepo.createUser(
        {
          role: record.role,
          mobileNumber: finalIdentifier,
          status: "Active",
          termsAndServices: tempUser.termsAndServices || false,
          privacyPolicy: tempUser.privacyPolicy || false,
          termsAndServicesAt: tempUser.termsAndServicesAt || null,
          privacyPolicyAt: tempUser.privacyPolicyAt || null,
        },
        { session }
      );
      const user = Array.isArray(userDoc) ? userDoc[0] : userDoc;

      let technicianProfile = null;
      if (record.role === "Technician") {
        technicianProfile = await profileRepo.createTechnicianShell(
          {
            userId: user._id,
            location: null,
            workStatus: "pending",
            profileComplete: false,
          },
          { session }
        );
      }

      await tempUserRepo.deleteSignup(
        { identifier: finalIdentifier, role: record.role },
        { session }
      );
      await otpRepo.wipeContextOtps(
        { identifier: finalIdentifier, role: record.role },
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      if (record.role === "Technician") {
        broadcastAdminUnreadCounts(getIo());
      }

      // P5: one device session per successful verification (never before
      // proof of identity — the OTP was consumed above).
      // NOTE: the signup transaction already committed + ended above, so
      // the device session is created outside it (post-authentication).
      const { session: authSession, refreshToken } = await createSession({
        userId: user._id,
        role: record.role,
        device,
      });
      const tokenPayload = {
        userId: user._id,
        role: record.role,
        tokenVersion: user.tokenVersion ?? 0,
        sid: String(authSession._id),
      };
      if (technicianProfile && technicianProfile[0]) {
        tokenPayload.technicianProfileId = technicianProfile[0]._id;
      }
      const token = signSessionAccessToken(tokenPayload);

      return {
        token,
        // P5 additive fields: existing `token` consumers keep working.
        refresh_token: refreshToken,
        expires_in: accessTokenExpiresInSeconds(),
        user: {
          _id: user._id,
          fname: user.fname || "",
          lname: user.lname || "",
          mobileNumber: user.mobileNumber,
          email: user.email || "",
          role: record.role,
          profileComplete: false,
        },
        technicianProfileId: technicianProfile?.[0]?._id || null,
      };
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      // P2 (Task 3/4): a concurrent double-signup that survived wiping hits
      // the mobileNumber unique index — map the raw duplicate-key error to
      // the normal contract response instead of leaking a 500/Mongo error.
      if (err && err.code === 11000) {
        const dup = new Error("Mobile number already registered. Please login with your existing account.");
        dup.statusCode = 409;
        dup.code = "MOBILE_ALREADY_EXISTS";
        dup.details = { identifier: finalIdentifier };
        throw dup;
      }
      throw err;
    }
  } else if (record.purpose === "LOGIN") {
    if (["Owner", "Admin"].includes(record.role)) {
      const err = new Error("Owner/Admin accounts use phone number and password login only");
      err.statusCode = 403;
      err.code = "PASSWORD_ONLY_LOGIN";
      throw err;
    }

    const user = await userRepo.findByMobileAndRole(finalIdentifier, record.role);
    if (!user) {
      const err = new Error("User account not found.");
      err.statusCode = 404;
      err.code = "USER_NOT_FOUND";
      throw err;
    }

    if (user.status === "Deleted") {
      const err = new Error("Account deleted");
      err.statusCode = 403;
      err.code = "ACCOUNT_DELETED";
      throw err;
    }

    if (user.status === "Blocked") {
      const err = new Error("Account blocked");
      err.statusCode = 403;
      err.code = "ACCOUNT_BLOCKED";
      throw err;
    }

    // P2 (Task 7): Inactive accounts must not authenticate — previously a
    // token was issued here and every later Auth call 403'd. Same wording
    // as the per-request resolver (resolveAuth ACCOUNT_INACTIVE).
    if (user.status === "Inactive") {
      const err = new Error("This account is inactive. Contact support.");
      err.statusCode = 403;
      err.code = "ACCOUNT_INACTIVE";
      throw err;
    }

    // P2 (Task 7): suspended Technicians must not receive a token — previously
    // only "deleted" was refused here and suspension bit only at later gates.
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

    await userRepo.updateLastLogin(user._id);
    await otpRepo.deleteOtpById(record._id);

    let technicianProfileId = null;
    if (user.role === "Technician") {
      const tech = await profileRepo.findByUserId(user._id, "_id");
      technicianProfileId = tech?._id || null;
    }

    // P5: one device session per successful verification.
    const { session: authSession, refreshToken } = await createSession({
      userId: user._id,
      role: user.role,
      device,
    });

    const token = signSessionAccessToken({
      userId: user._id,
      role: user.role,
      technicianProfileId,
      tokenVersion: user.tokenVersion ?? 0,
      sid: String(authSession._id),
    });

    return {
      token,
      // P5 additive fields: existing `token` consumers keep working.
      refresh_token: refreshToken,
      expires_in: accessTokenExpiresInSeconds(),
      user: {
        _id: user._id,
        fname: user.fname || "",
        lname: user.lname || "",
        mobileNumber: user.mobileNumber,
        email: user.email || "",
        role: user.role,
        profileComplete: user.profileComplete || false,
      },
      technicianProfileId,
    };
  } else {
    const err = new Error("Invalid OTP purpose");
    err.statusCode = 400;
    err.code = "OTP_PURPOSE_INVALID";
    throw err;
  }
};

/**
 * Sets password for Owner post-OTP verification.
 */
export const setPasswordInternal = async ({ userId, password }) => {
  if (!userId) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "UNAUTHORIZED";
    throw err;
  }

  // P3: input rule via the validation seam (byte-identical errors).
  validateSetPasswordInput(password);

  const user = await userRepo.findById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  // P3: persistence via repository (no Document.save() in the service).
  const hashedPassword = await bcrypt.hash(password, 10);
  await userRepo.setUserPassword(userId, hashedPassword);

  return true;
};

/**
 * Handles user login (password for Owner/Admin, OTP request for Customer/Technician).
 */
export const loginInternal = async ({ identifier, mobileNumber, role, password, privileged, device = {} }) => {
  // P3: input rule via the validation seam (byte-identical error).
  const finalIdentifier = requireLoginIdentifier(identifier, mobileNumber);
  const requestedRole = privileged ? null : normalizeRole(role);

  const user = await userRepo.findLoginUserByMobile(finalIdentifier);
  if (!user) {
    const err = new Error("User not found. Please signup first.");
    err.statusCode = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const normalizedRole = user.role;
  if (!privileged && requestedRole && requestedRole !== user.role) {
    // P2 (Task 8): do not reveal which role the identifier is registered
    // under. Status/code/envelope preserved; the registeredRole/requestedRole
    // oracle values are removed.
    const err = new Error(
      "Account role mismatch. Please use the correct login."
    );
    err.statusCode = 403;
    err.code = "ROLE_MISMATCH";
    err.details = {};
    throw err;
  }

  if (user.status === "Blocked") {
    const err = new Error("Account is blocked. Please contact support.");
    err.statusCode = 403;
    err.code = "ACCOUNT_BLOCKED";
    throw err;
  }

  if (user.status === "Deleted") {
    const err = new Error("Account deleted");
    err.statusCode = 403;
    err.code = "ACCOUNT_DELETED";
    throw err;
  }

  // P2 (Task 7): same login-time enforcement as the OTP-verify path —
  // Inactive/suspended accounts must not receive an OTP either.
  if (user.status === "Inactive") {
    const err = new Error("This account is inactive. Contact support.");
    err.statusCode = 403;
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }

  // Owner & Admin password login
  if (privileged || normalizedRole === "Owner" || normalizedRole === "Admin") {
    if (privileged && !["Owner", "Admin"].includes(user.role)) {
      // P2 (Task 8): same oracle removal on the privileged endpoint.
      const err = new Error(
        "This endpoint is for Owner/Admin accounts only."
      );
      err.statusCode = 403;
      err.code = "ROLE_MISMATCH";
      err.details = {};
      throw err;
    }

    if (!user.password) {
      const err = new Error("Password not set for this account. Use the Owner signup flow to set one.");
      err.statusCode = 400;
      err.code = "PASSWORD_NOT_SET";
      throw err;
    }

    if (!password) {
      const err = new Error("Password is required for login");
      err.statusCode = 400;
      err.code = "PASSWORD_REQUIRED";
      throw err;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const err = new Error("Invalid password");
      err.statusCode = 401;
      err.code = "INVALID_CREDENTIALS";
      throw err;
    }

    await userRepo.updateLastLogin(user._id);

    // P5: one device session per successful password authentication.
    const { session: authSession, refreshToken } = await createSession({
      userId: user._id,
      role: user.role,
      device,
    });
    const token = signSessionAccessToken({
      userId: user._id,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 0,
      sid: String(authSession._id),
    });

    return {
      type: "PASSWORD_LOGIN",
      token,
      // P5 additive fields: existing `token` consumers keep working.
      refresh_token: refreshToken,
      expires_in: accessTokenExpiresInSeconds(),
      userId: user._id,
      role: user.role,
    };
  }

  // Customer & Technician OTP login
  if (normalizedRole === "Technician") {
    const techProfile = await profileRepo.findByUserId(user._id, "workStatus");
    if (techProfile?.workStatus === "deleted") {
      const err = new Error("Account deleted");
      err.statusCode = 403;
      err.code = "ACCOUNT_DELETED";
      throw err;
    }
    // P2 (Task 7): suspended Technicians get no OTP (previously login
    // succeeded and suspension bit only at later gates).
    if (techProfile?.workStatus === "suspended") {
      const err = new Error("Technician account is suspended. Contact support.");
      err.statusCode = 403;
      err.code = "TECHNICIAN_SUSPENDED";
      throw err;
    }
  }

  await otpRepo.wipeContextOtps({
    identifier: finalIdentifier,
    role: normalizedRole,
    purpose: "LOGIN",
  });

  const otp = generateSecureOtp();
  const hashedOtp = await bcrypt.hash(otp, 10);

  await otpRepo.issueOtp({
    identifier: finalIdentifier,
    role: normalizedRole,
    purpose: "LOGIN",
    otpHash: hashedOtp,
  });

  try {
    await sendSms(finalIdentifier, otp);
  } catch (smsErr) {
    const err = new Error("Failed to send OTP. Please try again.");
    err.statusCode = 500;
    err.code = "SMS_SEND_FAILED";
    throw err;
  }

  return {
    type: "OTP_SENT",
    identifier: finalIdentifier,
    role: normalizedRole,
    purpose: "LOGIN",
    expiresInSeconds: 300,
  };
};

/**
 * Accepts Terms and Privacy policy for authenticated user.
 */
export const acceptTermsInternal = async ({ userId, termsAndServices, privacyPolicy }) => {
  if (!userId) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "UNAUTHORIZED";
    throw err;
  }

  // P3: input rule via the validation seam (byte-identical error).
  const updateData = validateAcceptTermsInput(termsAndServices, privacyPolicy);

  const user = await userRepo.updateUserById(userId, updateData, { new: true }, { select: "-password" });
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  return {
    termsAndServices: user.termsAndServices,
    privacyPolicy: user.privacyPolicy,
    termsAndServicesAt: user.termsAndServicesAt,
    privacyPolicyAt: user.privacyPolicyAt,
  };
};

/**
 * Checks user existence by identifier (Admin/Owner debug).
 */
export const checkUserByIdentifierInternal = async (identifier) => {
  if (!identifier) {
    const err = new Error("Identifier required");
    err.statusCode = 400;
    throw err;
  }

  // P2 (Task 8/9): never expose credential state through the debug lookup —
  // hasPassword was an account-probing oracle. The endpoint stays
  // Owner/Admin-only (route guards unchanged); admins keep the account +
  // technician linkage they need for support. P3: reads via repositories.
  const user = await userRepo.findDebugSubjectByIdentifier(identifier);
  if (!user) {
    const err = new Error("User not found with this identifier");
    err.statusCode = 404;
    err.result = { identifier };
    throw err;
  }

  const techProfile = await profileRepo.findByUserId(user._id, "_id workStatus");
  const userObj = user.toObject();

  return {
    user: userObj,
    hasTechnicianProfile: !!techProfile,
    technicianProfile: techProfile || null,
  };
};
