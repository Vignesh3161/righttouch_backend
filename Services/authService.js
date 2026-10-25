import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../Schemas/User.js";
import Otp from "../Schemas/Otp.js";
import TempUser from "../Schemas/TempUser.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { normalizeIndianMobile } from "../Utils/phoneValidation.js";
import { generateSecureOtp } from "../Utils/otpGenerator.js";
import { signToken } from "../Utils/token.js";
import sendSms from "../Utils/sendSMS.js";
import { broadcastAdminUnreadCounts } from "../Controllers/adminNotificationController.js";
import { getIo } from "../Utils/ioAccess.js";
import { sendWelcomeNotification } from "../Utils/sendNotification.js";

/**
 * Internal Auth Service
 * Encapsulates authentication, OTP handling, JWT issuance, and login/signup business logic.
 */

// Shared with service-completion OTP; re-exported for existing callers/tests.
export { generateSecureOtp };

const normalizeRole = (role) => {
  if (!role) return null;
  const normalized = role.toString().trim().toLowerCase();
  if (["owner", "admin", "customer", "technician"].includes(normalized)) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return null;
};

// C1: public self-registration allowlist. Admin/Owner accounts must be
// provisioned through a trusted authorized flow — never public signup/OTP.
export const PUBLIC_SIGNUP_ROLES = ["Customer", "Technician"];

const assertPublicSignupRole = (normRole, rawRole) => {
  if (!normRole) {
    const err = new Error("Invalid role. Allowed roles: Customer, Technician");
    err.statusCode = 400;
    err.code = "INVALID_ROLE";
    err.details = { received: rawRole ?? null, allowed: PUBLIC_SIGNUP_ROLES };
    throw err;
  }
  if (!PUBLIC_SIGNUP_ROLES.includes(normRole)) {
    const err = new Error(
      `${normRole} registration is not allowed via public signup. Contact an authorized administrator.`
    );
    err.statusCode = 403;
    err.code = "PUBLIC_SIGNUP_ROLE_FORBIDDEN";
    err.details = { received: normRole, allowed: PUBLIC_SIGNUP_ROLES };
    throw err;
  }
  return normRole;
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

  // C1: close Admin/Owner self-registration on the public signup path.
  // The persisted role below comes from this validated allowlist, never
  // directly from the request body. inviteCode is intentionally no longer
  // accepted as a bypass — privileged provisioning lives outside signup.
  assertPublicSignupRole(normRole, role);

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

  // H1/H2: repeat signup requests share one cooldown + one attempt budget.
  // The check-and-reissue runs transactionally (replica set) so concurrent
  // /signup calls collapse to a single OTP/SMS instead of resetting the
  // attacker's budget or spamming SMS.
  const issuedOtp = await withOtpTxn(async (session) => {
    const opts = session ? { session } : {};
    const latest = await Otp.findOne({
      identifier: normalizedIdentifier,
      role: normRole,
      purpose: "SIGNUP",
    })
      .sort({ createdAt: -1 })
      .session(session || undefined);
    if (latest && Date.now() - new Date(latest.createdAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
      const err = new Error("An OTP was sent recently. Please wait before requesting another.");
      err.statusCode = 429;
      err.code = "OTP_COOLDOWN";
      throw err;
    }
    // Carry the verification budget forward — never reset it on reissue.
    const carriedAttempts = Math.min(Number(latest?.attempts) || 0, OTP_MAX_ATTEMPTS);

    // Clean old SIGNUP OTPs
    await Otp.deleteMany(
      {
        identifier: normalizedIdentifier,
        role: normRole,
        purpose: "SIGNUP",
      },
      opts
    );

    // Generate CSPRNG OTP
    const otp = generateSecureOtp();
    const hashedOtp = await bcrypt.hash(otp, 10);

    // Store OTP
    await Otp.create(
      [
        {
          identifier: normalizedIdentifier,
          role: normRole,
          purpose: "SIGNUP",
          otp: hashedOtp,
          attempts: carriedAttempts,
          expiresAt: Date.now() + OTP_TTL_MS, // 5 minutes
        },
      ],
      opts
    );
    return otp;
  });
  const otp = issuedOtp;

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

export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_TTL_MS = 5 * 60 * 1000;

// H1/H2: run the check-and-reissue sequence inside a transaction when the
// topology supports it (replica set in production). The cooldown read and the
// delete+create then serialize, so concurrent resends on any replica collapse
// to a single SMS. Standalone/dev falls back to sequential ops (documented,
// not distributed-safe).
const withOtpTxn = async (fn) => {
  let session = null;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(() => fn(session).then((r) => { result = r; }));
    return result;
  } catch (e) {
    if (/replica set|Transaction|mongos/.test(String(e?.message || ""))) {
      return await fn(null);
    }
    throw e;
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
};

/**
 * Resends OTP with 60-second cooldown check.
 *
 * H1: the reissued OTP inherits the previous attempt count (capped) — a
 * resend never resets an attacker's verification budget.
 * H2: cooldown is checked inside the reissue transaction against the shared
 * Otp collection, so it holds across replicas for sequential requests and
 * serializes concurrent ones on a replica set.
 */
export const resendOtpInternal = async ({ identifier, mobileNumber }) => {
  const finalIdentifier = normalizeIndianMobile((identifier || mobileNumber)?.trim());
  if (!finalIdentifier) {
    const err = new Error("Valid mobile number required (10 digits, optional +91 prefix)");
    err.statusCode = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  const issued = await withOtpTxn(async (session) => {
    const opts = session ? { session } : {};
    const lastOtp = await Otp.findOne({ identifier: finalIdentifier })
      .sort({ createdAt: -1 })
      .session(session || undefined);
    if (!lastOtp) {
      const err = new Error("No recent OTP found. Please login or signup again.");
      err.statusCode = 404;
      err.code = "OTP_NOT_FOUND";
      throw err;
    }

    // 60s cooldown check — inside the txn so concurrent resends serialize.
    if (Date.now() - new Date(lastOtp.createdAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
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

    // H1: carry the verification budget forward — never reset it on resend.
    const carriedAttempts = Math.min(Number(lastOtp.attempts) || 0, OTP_MAX_ATTEMPTS);

    await Otp.deleteMany({ identifier: finalIdentifier, role, purpose }, opts);

    const otp = generateSecureOtp();
    const hashedOtp = await bcrypt.hash(otp, 10);

    const [created] = await Otp.create(
      [
        {
          identifier: finalIdentifier,
          role,
          purpose,
          otp: hashedOtp,
          attempts: carriedAttempts,
          expiresAt: Date.now() + OTP_TTL_MS,
        },
      ],
      opts
    );
    return { created, otp, role, purpose };
  });

  try {
    await sendSms(finalIdentifier, issued.otp);
  } catch (smsErr) {
    const err = new Error("Failed to send OTP. Please try again.");
    err.statusCode = 500;
    err.code = "SMS_SEND_FAILED";
    throw err;
  }

  return {
    identifier: finalIdentifier,
    role: issued.role,
    purpose: issued.purpose,
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

  // H1: atomically consume exactly one verification attempt BEFORE comparing.
  // The $inc + attempts<$lt filter run as a single atomic update, so N
  // concurrent wrong guesses consume N distinct attempts and the
  // (MAX+1)-th concurrent guess always fails closed — no read-then-increment
  // race. A correct guess also consumes its attempt; the record is deleted
  // on success below, so the budget never wrongly blocks a valid OTP.
  const record = await Otp.findOneAndUpdate(
    {
      identifier: finalIdentifier,
      verified: false,
      otp: { $exists: true },
      expiresAt: { $gte: Date.now() },
      attempts: { $lt: OTP_MAX_ATTEMPTS },
    },
    { $inc: { attempts: 1 } },
    { new: true, sort: { createdAt: -1 } }
  );
  if (!record) {
    const exhausted = await Otp.findOne({
      identifier: finalIdentifier,
      verified: false,
      otp: { $exists: true },
      expiresAt: { $gte: Date.now() },
      attempts: { $gte: OTP_MAX_ATTEMPTS },
    })
      .sort({ createdAt: -1 })
      .lean();
    if (exhausted) {
      const err = new Error("Too many attempts. Request new OTP.");
      err.statusCode = 429;
      err.code = "OTP_TOO_MANY_ATTEMPTS";
      throw err;
    }
    const err = new Error("OTP expired, invalid, or already used");
    err.statusCode = 400;
    err.code = "OTP_INVALID_OR_EXPIRED";
    throw err;
  }

  const isMatch = await bcrypt.compare(otp, record.otp);
  if (!isMatch) {
    const remainingAttempts = Math.max(0, OTP_MAX_ATTEMPTS - record.attempts);
    const err = new Error(`Invalid OTP. ${remainingAttempts} attempts remaining`);
    err.statusCode = 400;
    err.code = "OTP_INVALID";
    err.details = { attemptsRemaining: remainingAttempts };
    throw err;
  }

  await Otp.updateOne({ _id: record._id }, { $set: { verified: true } });

  if (record.purpose === "SIGNUP") {
    // C1: OTP completion cannot bypass the public-signup allowlist, even if a
    // stale/forged OTP record carries a privileged role.
    assertPublicSignupRole(record.role, record.role);
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

      // 🔔 Welcome notification (socket + FCM; best-effort)
      sendWelcomeNotification({
        userId: user._id,
        role: record.role,
        isNewSignup: true,
        userName: [user.fname, user.lname].filter(Boolean).join(" ").trim(),
        technicianProfileId: technicianProfile?.[0]?._id || null,
      }).catch((e) => console.warn("Welcome notification error:", e.message));

      const tokenPayload = {
        userId: user._id,
        role: record.role,
        // H4: bind the token to the current revocation generation.
        tokenVersion: user.tokenVersion ?? 0,
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
      // H4: bind the token to the current revocation generation.
      tokenVersion: user.tokenVersion ?? 0,
    });

    // 🔔 Welcome-back notification (socket + FCM; best-effort)
    sendWelcomeNotification({
      userId: user._id,
      role: user.role,
      isNewSignup: false,
      userName: [user.fname, user.lname].filter(Boolean).join(" ").trim(),
      technicianProfileId,
    }).catch((e) => console.warn("Welcome notification error:", e.message));

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

  // H7: upper bound keeps the approved minimum intact while preventing
  // oversized-input abuse against the password hasher (bcrypt silently
  // truncates past 72 bytes, which would otherwise give a false sense of
  // added strength and burn CPU).
  if (password.length > 128) {
    const err = new Error("Password must not exceed 128 characters");
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
  // H4+H7: a password change revokes every previously issued token (including
  // the one used for this call) — the user re-authenticates for a new session.
  user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
  await user.save();

  return true;
};

/**
 * H4: explicitly revoke all sessions for a user (role change, suspension
 * lift, admin security action). No current code path mutates User.role —
 * verified by audit — so this is the designated hook for any future
 * privileged-account lifecycle change: bump, then re-issue.
 */
export const bumpTokenVersion = async (userId) => {
  if (!userId) {
    const err = new Error("userId required");
    err.statusCode = 400;
    throw err;
  }
  const updated = await User.findByIdAndUpdate(
    userId,
    { $inc: { tokenVersion: 1 } },
    { new: true }
  ).select("tokenVersion");
  if (!updated) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  return updated.tokenVersion ?? 0;
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
    // H4: bind the token to the current revocation generation.
    const token = signToken({ userId: user._id, role: user.role, tokenVersion: user.tokenVersion ?? 0 });

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
