import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../Schemas/User.js";
import Otp from "../Schemas/Otp.js";
import TempUser from "../Schemas/TempUser.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { normalizeIndianMobile } from "../Utils/phoneValidation.js";
import { signToken } from "../Utils/token.js";
import sendSms from "../Utils/sendSMS.js";
import { broadcastAdminUnreadCounts } from "../Controllers/adminNotificationController.js";
import { getIo } from "../Utils/ioAccess.js";

/**
 * Internal Auth Service
 * Encapsulates authentication, OTP handling, JWT issuance, and login/signup business logic.
 */

// Generate a cryptographically secure 4-digit OTP
export const generateSecureOtp = () => {
  return crypto.randomInt(1000, 10000).toString();
};

const normalizeRole = (role) => {
  if (!role) return null;
  const normalized = role.toString().trim().toLowerCase();
  if (["owner", "admin", "customer", "technician"].includes(normalized)) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return null;
};

/**
 * Handles user signup and OTP dispatch.
 */
export const signupAndSendOtpInternal = async ({ identifier, role, termsAndServices, privacyPolicy, inviteCode }) => {
  const normRole = normalizeRole(role);
  const rawIdentifier = (identifier || "")?.trim();
  const normalizedIdentifier = normalizeIndianMobile(rawIdentifier);

  if (!normalizedIdentifier) {
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

  if (!normRole) {
    const err = new Error("Identifier and role required");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    err.details = { required: ["identifier", "role"] };
    throw err;
  }

  // Owner signup invite code enforcement
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

  // Customer & Technician terms/privacy validation
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

  // Check duplicate active user
  const existingUser = await User.findOne({ mobileNumber: normalizedIdentifier }).select("_id status role");
  if (existingUser) {
    if (existingUser.status === "Deleted") {
      // Anonymize zombie deleted user to free the mobile number
      const timestamp = Date.now();
      const anonymizedMobile = `deleted_${existingUser._id}_${timestamp}`;
      const anonymizedEmail = `deleted_${existingUser._id}_${timestamp}@example.invalid`;

      await User.updateOne(
        { _id: existingUser._id },
        { $set: { mobileNumber: anonymizedMobile, email: anonymizedEmail } }
      );
    } else {
      const message =
        existingUser.role === "Technician"
          ? "Mobile number already registered as a Technician. Please login with your technician account."
          : "Mobile number already registered as a Customer. Please login with your Customer account.";
      const err = new Error(message);
      err.statusCode = 409;
      err.code = "MOBILE_ALREADY_EXISTS";
      err.details = { identifier: normalizedIdentifier, existingRole: existingUser.role };
      throw err;
    }
  }

  // Create / update temp user
  const updateFields = {
    identifier: normalizedIdentifier,
    role: normRole,
    tempstatus: "Pending",
  };
  if (termsAndServices === true) {
    updateFields.termsAndServices = true;
    updateFields.termsAndServicesAt = new Date();
  }
  if (privacyPolicy === true) {
    updateFields.privacyPolicy = true;
    updateFields.privacyPolicyAt = new Date();
  }

  const tempUser = await TempUser.findOneAndUpdate(
    { identifier: normalizedIdentifier, role: normRole },
    updateFields,
    { upsert: true, new: true }
  );

  if (!tempUser) {
    const err = new Error("Failed to create signup record");
    err.statusCode = 500;
    err.code = "TEMPUSER_CREATE_FAILED";
    throw err;
  }

  // Clean old SIGNUP OTPs
  await Otp.deleteMany({
    identifier: normalizedIdentifier,
    role: normRole,
    purpose: "SIGNUP",
  });

  // Generate CSPRNG OTP
  const otp = generateSecureOtp();
  const hashedOtp = await bcrypt.hash(otp, 10);

  // Store OTP
  await Otp.create({
    identifier: normalizedIdentifier,
    role: normRole,
    purpose: "SIGNUP",
    otp: hashedOtp,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
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
export const resendOtpInternal = async ({ identifier, mobileNumber }) => {
  const finalIdentifier = normalizeIndianMobile((identifier || mobileNumber)?.trim());
  if (!finalIdentifier) {
    const err = new Error("Valid mobile number required (10 digits, optional +91 prefix)");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  const lastOtp = await Otp.findOne({ identifier: finalIdentifier }).sort({ createdAt: -1 });
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

  const { role, purpose } = lastOtp;
  if (role === "Owner" && purpose !== "SIGNUP") {
    const err = new Error("Owner can only resend OTP for signup");
    err.statusCode = 403;
    err.code = "FORBIDDEN";
    throw err;
  }

  await Otp.deleteMany({ identifier: finalIdentifier, role, purpose });

  const otp = generateSecureOtp();
  const hashedOtp = await bcrypt.hash(otp, 10);

  await Otp.create({
    identifier: finalIdentifier,
    role,
    purpose,
    otp: hashedOtp,
    expiresAt: Date.now() + 5 * 60 * 1000,
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
export const verifyOtpInternal = async ({ identifier, mobileNumber, otp, role }) => {
  const finalIdentifier = normalizeIndianMobile((identifier || mobileNumber)?.trim());
  if (!finalIdentifier || !otp) {
    const err = new Error("Identifier and OTP required");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    err.details = { required: ["identifier", "otp"] };
    throw err;
  }

  const query = {
    identifier: finalIdentifier,
    verified: false,
    otp: { $exists: true },
    expiresAt: { $gte: Date.now() },
  };

  const record = await Otp.findOne(query).sort({ createdAt: -1 });
  if (!record) {
    const err = new Error("OTP expired, invalid, or already used");
    err.statusCode = 400;
    err.code = "OTP_INVALID_OR_EXPIRED";
    throw err;
  }

  if (record.attempts >= 5) {
    const err = new Error("Too many attempts. Request new OTP.");
    err.statusCode = 429;
    err.code = "OTP_TOO_MANY_ATTEMPTS";
    throw err;
  }

  const isMatch = await bcrypt.compare(otp, record.otp);
  if (!isMatch) {
    await Otp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    const remainingAttempts = Math.max(0, 5 - (record.attempts + 1));
    const err = new Error(`Invalid OTP. ${remainingAttempts} attempts remaining`);
    err.statusCode = 400;
    err.code = "OTP_INVALID";
    err.details = { attemptsRemaining: remainingAttempts };
    throw err;
  }

  await Otp.updateOne({ _id: record._id }, { $set: { verified: true } });

  if (record.purpose === "SIGNUP") {
    const tempUser = await TempUser.findOne({ identifier: finalIdentifier, role: record.role });
    if (!tempUser) {
      const err = new Error("No signup request found. Please signup first.");
      err.statusCode = 404;
      err.code = "TEMPUSER_NOT_FOUND";
      throw err;
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const userDoc = await User.create(
        [
          {
            role: record.role,
            mobileNumber: finalIdentifier,
            status: "Active",
            termsAndServices: tempUser.termsAndServices || false,
            privacyPolicy: tempUser.privacyPolicy || false,
            termsAndServicesAt: tempUser.termsAndServicesAt || null,
            privacyPolicyAt: tempUser.privacyPolicyAt || null,
          },
        ],
        { session }
      );
      const user = userDoc[0];

      let technicianProfile = null;
      if (record.role === "Technician") {
        technicianProfile = await TechnicianProfile.create(
          [
            {
              userId: user._id,
              location: null,
              workStatus: "pending",
              profileComplete: false,
            },
          ],
          { session }
        );
      }

      await TempUser.deleteOne({ identifier: finalIdentifier, role: record.role }, { session });
      await Otp.deleteMany({ identifier: finalIdentifier, role: record.role }, { session });

      await session.commitTransaction();
      session.endSession();

      if (record.role === "Technician") {
        broadcastAdminUnreadCounts(getIo());
      }

      const tokenPayload = {
        userId: user._id,
        role: record.role,
      };
      if (technicianProfile && technicianProfile[0]) {
        tokenPayload.technicianProfileId = technicianProfile[0]._id;
      }
      const token = signToken(tokenPayload);

      return {
        token,
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
      throw err;
    }
  } else if (record.purpose === "LOGIN") {
    if (["Owner", "Admin"].includes(record.role)) {
      const err = new Error("Owner/Admin accounts use phone number and password login only");
      err.statusCode = 403;
      err.code = "PASSWORD_ONLY_LOGIN";
      throw err;
    }

    const user = await User.findOne({ mobileNumber: finalIdentifier, role: record.role });
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

    if (user.role === "Technician") {
      const techProfile = await TechnicianProfile.findOne({ userId: user._id }).select("workStatus");
      if (techProfile?.workStatus === "deleted") {
        const err = new Error("Account deleted");
        err.statusCode = 403;
        err.code = "ACCOUNT_DELETED";
        throw err;
      }
    }

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    await Otp.deleteOne({ _id: record._id });

    let technicianProfileId = null;
    if (user.role === "Technician") {
      const tech = await TechnicianProfile.findOne({ userId: user._id }).select("_id");
      technicianProfileId = tech?._id || null;
    }

    const token = signToken({
      userId: user._id,
      role: user.role,
      technicianProfileId,
    });

    return {
      token,
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

  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  user.password = hashedPassword;
  await user.save();

  return true;
};

/**
 * Handles user login (password for Owner/Admin, OTP request for Customer/Technician).
 */
export const loginInternal = async ({ identifier, mobileNumber, role, password, privileged }) => {
  const finalIdentifier = normalizeIndianMobile((identifier || mobileNumber)?.trim());
  const requestedRole = privileged ? null : normalizeRole(role);

  if (!finalIdentifier) {
    const err = new Error("Valid mobile number required (10 digits, optional +91 prefix)");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  const user = await User.findOne({ mobileNumber: finalIdentifier }).select("+password role status");
  if (!user) {
    const err = new Error("User not found. Please signup first.");
    err.statusCode = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const normalizedRole = user.role;
  if (!privileged && requestedRole && requestedRole !== user.role) {
    const err = new Error(
      `This account is registered as a ${user.role}. Please use the ${user.role} app to login.`
    );
    err.statusCode = 403;
    err.code = "ROLE_MISMATCH";
    err.details = { registeredRole: user.role, requestedRole };
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

  // Owner & Admin password login
  if (privileged || normalizedRole === "Owner" || normalizedRole === "Admin") {
    if (privileged && !["Owner", "Admin"].includes(user.role)) {
      const err = new Error(
        `This endpoint is for Owner/Admin accounts only. This number is registered as a ${user.role}.`
      );
      err.statusCode = 403;
      err.code = "ROLE_MISMATCH";
      err.details = { registeredRole: user.role };
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

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    const token = signToken({ userId: user._id, role: user.role });

    return {
      type: "PASSWORD_LOGIN",
      token,
      userId: user._id,
      role: user.role,
    };
  }

  // Customer & Technician OTP login
  if (normalizedRole === "Technician") {
    const techProfile = await TechnicianProfile.findOne({ userId: user._id }).select("workStatus");
    if (techProfile?.workStatus === "deleted") {
      const err = new Error("Account deleted");
      err.statusCode = 403;
      err.code = "ACCOUNT_DELETED";
      throw err;
    }
  }

  await Otp.deleteMany({
    identifier: finalIdentifier,
    role: normalizedRole,
    purpose: "LOGIN",
  });

  const otp = generateSecureOtp();
  const hashedOtp = await bcrypt.hash(otp, 10);

  await Otp.create({
    identifier: finalIdentifier,
    role: normalizedRole,
    purpose: "LOGIN",
    otp: hashedOtp,
    expiresAt: Date.now() + 5 * 60 * 1000,
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

  const user = await User.findByIdAndUpdate(userId, updateData, { new: true }).select("-password");
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

  const user = await User.findOne({ mobileNumber: identifier }).select(
    "+password _id role fname lname mobileNumber email status createdAt"
  );
  if (!user) {
    const err = new Error("User not found with this identifier");
    err.statusCode = 404;
    err.result = { identifier };
    throw err;
  }

  const hasPassword = !!user.password;
  const techProfile = await TechnicianProfile.findOne({ userId: user._id }).select("_id workStatus");
  const userObj = user.toObject();
  delete userObj.password;

  return {
    user: userObj,
    hasPassword,
    hasTechnicianProfile: !!techProfile,
    technicianProfile: techProfile || null,
  };
};
