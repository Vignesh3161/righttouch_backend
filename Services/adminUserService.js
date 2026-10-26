import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../Schemas/User.js";
import { normalizeIndianMobile } from "../Utils/phoneValidation.js";
import { writeAuditLog } from "../Utils/audit.js";

/**
 * Privileged user provisioning (Owner-only).
 *
 * Owner/Admin accounts cannot self-register through the public auth flows.
 * This service is the trusted replacement: only an authenticated Owner may
 * create another Admin/Owner or change an existing privileged user's role.
 *
 * Safety properties:
 *  - The target role is limited to the Admin/Owner allowlist.
 *  - Mobile numbers are normalized with the shared Indian mobile validator.
 *  - Passwords are bcrypt-hashed and never returned or logged.
 *  - Role changes bump tokenVersion so previously issued JWTs are revoked.
 *  - The last active Owner cannot be demoted.
 *  - Every create/role-change is written to AuditLog.
 */

const PRIVILEGED_ROLES = ["Admin", "Owner"];
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const NAME_MAX_LENGTH = 80;

const createError = (message, statusCode, code, details) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
};

const assertOwnerActor = (actor) => {
  const actorRole = (actor?.role || "").toString().trim().toLowerCase();
  if (actorRole !== "owner") {
    throw createError(
      "Owner access required to manage privileged users",
      403,
      "OWNER_ONLY"
    );
  }
};

const normalizePrivilegedRole = (role) => {
  const received = role === undefined || role === null ? null : String(role).trim();
  const normalized = received ? received.toLowerCase() : "";
  const match = PRIVILEGED_ROLES.find((allowed) => allowed.toLowerCase() === normalized);

  if (!match) {
    throw createError(
      "Invalid role. Allowed roles: Admin, Owner",
      400,
      "INVALID_ROLE",
      { received: received ?? null, allowed: PRIVILEGED_ROLES }
    );
  }

  return match;
};

const normalizeName = (value, field) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw createError(`${field} must be a string`, 400, "VALIDATION_ERROR");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > NAME_MAX_LENGTH) {
    throw createError(
      `${field} must not exceed ${NAME_MAX_LENGTH} characters`,
      400,
      "VALIDATION_ERROR"
    );
  }
  return trimmed;
};

const normalizeOptionalEmail = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw createError("email must be a string", 400, "VALIDATION_ERROR");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^\S+@\S+\.\S+$/.test(normalized)) {
    throw createError("Invalid email address", 400, "INVALID_EMAIL");
  }
  return normalized;
};

const serializeUser = (user) => {
  if (!user) return null;
  const doc = typeof user.toObject === "function" ? user.toObject() : user;
  return {
    _id: doc._id,
    fname: doc.fname || "",
    lname: doc.lname || "",
    mobileNumber: doc.mobileNumber,
    email: doc.email || "",
    role: doc.role,
    status: doc.status,
    createdAt: doc.createdAt || null,
    lastLoginAt: doc.lastLoginAt || null,
  };
};

const assertPassword = (password) => {
  if (typeof password !== "string" || password.length === 0) {
    throw createError("Password is required", 400, "VALIDATION_ERROR", {
      required: ["password"],
    });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw createError(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
      400,
      "VALIDATION_ERROR"
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw createError(
      `Password must not exceed ${PASSWORD_MAX_LENGTH} characters`,
      400,
      "VALIDATION_ERROR"
    );
  }
};

const isDuplicateKeyError = (err) => err?.code === 11000;

/**
 * List the current Owner/Admin team (sanitized — no password/token fields).
 */
export const listPrivilegedUsers = async ({ actor }) => {
  assertOwnerActor(actor);

  const users = await User.find({
    role: { $in: PRIVILEGED_ROLES },
    status: { $ne: "Deleted" },
  })
    .select("_id fname lname mobileNumber email role status createdAt lastLoginAt")
    .sort({ createdAt: 1 })
    .lean();

  return users.map(serializeUser);
};

/**
 * Create an Admin or Owner account with a password.
 * Owner actors only.
 */
export const createPrivilegedUser = async ({ actor, body = {} }) => {
  assertOwnerActor(actor);

  const role = normalizePrivilegedRole(body.role);
  const rawIdentifier = body.identifier ?? body.mobileNumber;
  const mobileNumber = normalizeIndianMobile(rawIdentifier);

  if (!mobileNumber) {
    throw createError(
      "Valid mobile number required (10 digits, optional +91 prefix)",
      400,
      rawIdentifier ? "INVALID_MOBILE_NUMBER" : "VALIDATION_ERROR",
      { required: ["identifier", "password", "role"] }
    );
  }

  assertPassword(body.password);

  const fname = normalizeName(body.fname, "fname");
  const lname = normalizeName(body.lname, "lname");
  const email = normalizeOptionalEmail(body.email);

  const existingUser = await User.findOne({ mobileNumber })
    .select("_id role status")
    .lean();

  if (existingUser) {
    throw createError(
      "Mobile number is already registered. Use the role-change endpoint instead.",
      409,
      "MOBILE_ALREADY_EXISTS",
      { identifier: mobileNumber, existingRole: existingUser.role }
    );
  }

  if (email) {
    const existingEmail = await User.findOne({ email }).select("_id role").lean();
    if (existingEmail) {
      throw createError(
        "Email address is already registered",
        409,
        "EMAIL_ALREADY_EXISTS",
        { email, existingRole: existingEmail.role }
      );
    }
  }

  const hashedPassword = await bcrypt.hash(body.password, 10);

  let user;
  try {
    user = await User.create({
      role,
      mobileNumber,
      password: hashedPassword,
      fname,
      lname,
      email,
      status: "Active",
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const field = err?.keyPattern?.email ? "email" : "mobileNumber";
      throw createError(
        field === "email"
          ? "Email address is already registered"
          : "Mobile number is already registered. Use the role-change endpoint instead.",
        409,
        field === "email" ? "EMAIL_ALREADY_EXISTS" : "MOBILE_ALREADY_EXISTS"
      );
    }
    throw err;
  }

  await writeAuditLog({
    actor: actor?.userId || actor?._id || null,
    actorRole: actor?.role || "Owner",
    action: "PRIVILEGED_USER_CREATED",
    targetType: "User",
    targetId: user._id,
    after: {
      role: user.role,
      mobileNumber: user.mobileNumber,
      fname: user.fname || "",
      lname: user.lname || "",
      email: user.email || "",
      status: user.status,
    },
    reason: "Owner created a privileged user",
  });

  return serializeUser(user);
};

/**
 * Change an existing privileged user's role (Admin <-> Owner).
 * Owner actors only. Demoting the last active Owner is blocked.
 */
export const changeUserRole = async ({ actor, targetUserId, role, reason }) => {
  assertOwnerActor(actor);

  if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
    throw createError("Invalid user id", 400, "VALIDATION_ERROR");
  }

  const newRole = normalizePrivilegedRole(role);

  const targetUser = await User.findById(targetUserId).select(
    "_id fname lname mobileNumber email role status tokenVersion"
  );

  if (!targetUser || targetUser.status === "Deleted") {
    throw createError("User not found", 404, "USER_NOT_FOUND");
  }

  if (!PRIVILEGED_ROLES.includes(targetUser.role)) {
    throw createError(
      "Only Admin or Owner accounts can be role-managed here",
      400,
      "TARGET_NOT_PRIVILEGED",
      { currentRole: targetUser.role, allowed: PRIVILEGED_ROLES }
    );
  }

  const previousRole = targetUser.role;

  if (previousRole === newRole) {
    throw createError(
      `User already has the ${newRole} role`,
      400,
      "ROLE_UNCHANGED",
      { currentRole: previousRole }
    );
  }

  if (
    previousRole === "Owner" &&
    targetUser.status === "Active" &&
    newRole !== "Owner"
  ) {
    const otherActiveOwners = await User.countDocuments({
      _id: { $ne: targetUser._id },
      role: "Owner",
      status: "Active",
    });

    if (otherActiveOwners < 1) {
      throw createError(
        "Cannot demote the last active Owner. Promote another Owner first.",
        409,
        "LAST_ACTIVE_OWNER"
      );
    }
  }

  targetUser.role = newRole;
  // Revoke every JWT issued before this role change. The Auth middleware
  // compares this counter against the token claim on every request.
  targetUser.tokenVersion = (Number(targetUser.tokenVersion) || 0) + 1;
  await targetUser.save();

  await writeAuditLog({
    actor: actor?.userId || actor?._id || null,
    actorRole: actor?.role || "Owner",
    action: "PRIVILEGED_USER_ROLE_CHANGED",
    targetType: "User",
    targetId: targetUser._id,
    before: { role: previousRole },
    after: { role: newRole },
    reason:
      typeof reason === "string" && reason.trim()
        ? reason.trim().slice(0, 500)
        : "Owner changed a privileged user's role",
    metadata: { tokenVersionBumped: true, sessionsRevoked: true },
  });

  return serializeUser(targetUser);
};
