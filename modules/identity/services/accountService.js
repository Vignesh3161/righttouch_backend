import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import Address from "../../cart-address/models/Address.js";
import ServiceBooking from "../../booking/models/ServiceBooking.js";
import { requireResendIdentifier, validateProvisionPassword } from "../validators/authRequests.js";
import { writeAuditLog } from "../../../shared/utils/audit.js";
// P3 seams: identity/technician persistence via repositories. Address and
// ServiceBooking stay direct: they are owned by the cart-address and booking
// modules (Task 20), and this cascade only performs scoped deletes/updates.
import * as userRepo from "../repositories/userRepository.js";
import * as otpRepo from "../repositories/otpRepository.js";
import * as tempUserRepo from "../repositories/tempUserRepository.js";
import * as profileRepo from "../repositories/profileRepository.js";
import * as kycRepo from "../../technician/repositories/kycRepository.js";
import * as sessionRepo from "../repositories/sessionRepository.js";

/**
 * Internal Account Service
 * Encapsulates self and admin user account deletion logic with multi-document transactions,
 * active owner safeguards, and snapshot preservation for service bookings.
 */

/**
 * Self account deletion by authenticated user.
 */
export const deleteMyAccountInternal = async ({ userId, tokenRole }) => {
  if (!userId) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const user = await userRepo.findById(userId, { session });
      if (!user) {
        const err = new Error("ACCOUNT_NOT_FOUND");
        err.statusCode = 404;
        throw err;
      }

      if (tokenRole && user.role !== tokenRole) {
        const err = new Error("ROLE_MISMATCH");
        err.statusCode = 401;
        throw err;
      }

      if (user.role === "Owner") {
        const activeOwners = await userRepo.countActiveOwnersExcluding(userId, { session });

        if (activeOwners < 1) {
          const err = new Error("OWNER_REQUIRED");
          err.statusCode = 400;
          throw err;
        }
      }

      // Cleanup addresses
      await Address.deleteMany({ customerId: userId }).session(session);
      await Address.deleteMany({ userId }).session(session);

      if (user.role === "Technician") {
        const techProfile = await profileRepo.findByUserId(userId, "_id", { session });

        if (techProfile) {
          const techProfileId = techProfile._id;
          await ServiceBooking.updateMany(
            { technicianId: techProfileId },
            {
              $set: {
                "technicianSnapshot.name": `${user.fname || ""} ${user.lname || ""}`.trim() || "Unknown",
                "technicianSnapshot.mobile": user.mobileNumber || "",
                "technicianSnapshot.deleted": true,
              },
            },
            { session }
          );

          await profileRepo.deleteById(techProfileId, { session });
          await kycRepo.deleteByTechnicianId(techProfileId, { session });
        }
      }

      await otpRepo.purgeOtpsByIdentifier(user.mobileNumber, { session });
      await tempUserRepo.purgeSignupsByIdentifier(user.mobileNumber, { session });

      // P5: drop every session row so no refresh token can restore access
      // after deletion (inside the same transaction).
      await sessionRepo.deleteByUserId(userId, { session });

      await userRepo.deleteUserById(userId, { session });
    });

    return true;
  } catch (err) {
    if (err.message === "ACCOUNT_NOT_FOUND") {
      const error = new Error("Account not found");
      error.statusCode = 404;
      throw error;
    }
    if (err.message === "OWNER_REQUIRED") {
      const error = new Error("At least one active owner required");
      error.statusCode = 400;
      throw error;
    }
    if (err.message === "ROLE_MISMATCH") {
      const error = new Error("Unauthorized");
      error.statusCode = 401;
      throw error;
    }
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Admin (Owner-only) deletion of target user account by ID.
 */
export const deleteUserByIdInternal = async ({ adminUser, targetUserId }) => {
  if (adminUser?.role !== "Owner") {
    const err = new Error("Owner access only");
    err.statusCode = 403;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
    const err = new Error("Invalid user ID");
    err.statusCode = 400;
    throw err;
  }

  const user = await userRepo.findById(targetUserId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  // P1 (Task 5): an Owner must not delete their own account through the
  // admin endpoint — self-service deletion (with its Owner-quorum guard)
  // is the only self-delete path. This also prevents accidental lockout.
  if (String(adminUser?.userId) === String(user._id)) {
    const err = new Error("You cannot delete your own account through this endpoint. Use delete-my-account instead.");
    err.statusCode = 400;
    err.code = "SELF_DELETE_NOT_ALLOWED";
    throw err;
  }

  // P1 (Task 5): never delete the last active Owner — the system would be
  // left with no viable administrator (mirrors the delete-my-account
  // OWNER_REQUIRED quorum).
  if (user.role === "Owner") {
    const otherActiveOwners = await userRepo.countActiveOwnersExcluding(user._id);
    if (otherActiveOwners < 1) {
      const err = new Error("At least one active owner required");
      err.statusCode = 400;
      err.code = "OWNER_REQUIRED";
      throw err;
    }
  }

  if (user.status === "Deleted") {
    const err = new Error("User already deleted");
    err.statusCode = 400;
    throw err;
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Address.deleteMany({ customerId: targetUserId }).session(session);
      await Address.deleteMany({ userId: targetUserId }).session(session);

      if (user.role === "Technician") {
        const techProfile = await profileRepo.findByUserId(targetUserId, "_id", { session });

        if (techProfile) {
          await ServiceBooking.updateMany(
            { technicianId: techProfile._id },
            {
              $set: {
                "technicianSnapshot.name": `${user.fname || ""} ${user.lname || ""}`.trim() || "Unknown",
                "technicianSnapshot.mobile": user.mobileNumber || "",
                "technicianSnapshot.deleted": true,
              },
            },
            { session }
          );

          await profileRepo.deleteById(techProfile._id, { session });
          await kycRepo.deleteByTechnicianId(techProfile._id, { session });
        }
      }

      await otpRepo.purgeOtpsByIdentifier(user.mobileNumber, { session });
      await tempUserRepo.purgeSignupsByIdentifier(user.mobileNumber, { session });

      // P5: drop every session row so no refresh token can restore access
      // after deletion (inside the same transaction).
      await sessionRepo.deleteByUserId(targetUserId, { session });

      await userRepo.deleteUserById(targetUserId, { session });
    });

    return { deletedUserId: targetUserId, role: user.role };
  } catch (err) {
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * P1 (Task 4): Owner-only Admin provisioning.
 *
 * Public Admin signup stays disabled (see PUBLIC_SIGNUP_ROLES in
 * authService.js). The ONLY creation path for Admin accounts is this
 * Owner-authenticated flow. Bootstrap order: first Owner via invite-gated
 * public Owner signup → Owner provisions Admins here. No seed/duplicate
 * bootstrap system is introduced.
 *
 * Only the "Admin" role can be provisioned (Owner creation stays
 * invite-gated; Customer/Technician have their own OTP signup rails).
 * The initial password is set by the Owner over the admin console; it is
 * bcrypt-hashed (cost 10, same as set-password) and NEVER echoed back.
 */
export const provisionAdminInternal = async ({ ownerUser, identifier, mobileNumber, password, fname, lname, email }) => {
  if (!ownerUser || ownerUser.role !== "Owner") {
    const err = new Error("Owner access only");
    err.statusCode = 403;
    err.code = "FORBIDDEN";
    throw err;
  }

  // P3: input rules via the validation seam (byte-identical errors).
  const normalizedIdentifier = requireResendIdentifier(identifier, mobileNumber);
  validateProvisionPassword(password);

  const existingUser = await userRepo.findDuplicateByIdentifier(normalizedIdentifier);
  if (existingUser) {
    if (existingUser.status === "Deleted") {
      await userRepo.anonymizeDeletedUser(existingUser._id);
    } else {
      const err = new Error("Mobile number already registered. Please login with the existing account.");
      err.statusCode = 409;
      err.code = "MOBILE_ALREADY_EXISTS";
      // P2 (Task 8): no existingRole oracle (matches public signup).
      err.details = { identifier: normalizedIdentifier };
      throw err;
    }
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  // NOTE: email is omitted when absent — the User schema rejects "" as an
  // invalid email, while undefined skips validation (same as OTP signup,
  // which never sets an email at creation).
  const user = await userRepo.createUser({
    role: "Admin",
    mobileNumber: normalizedIdentifier,
    status: "Active",
    password: passwordHash,
    fname: fname || "",
    lname: lname || "",
    ...(email ? { email } : {}),
    profileComplete: true,
    termsAndServices: false,
    privacyPolicy: false,
  });

  await writeAuditLog({
    actor: ownerUser.userId,
    actorRole: ownerUser.role,
    action: "ADMIN_PROVISIONED",
    targetType: "User",
    targetId: user._id,
    metadata: { mobileNumber: normalizedIdentifier, role: "Admin" },
  });

  return {
    userId: user._id,
    mobileNumber: user.mobileNumber,
    role: user.role,
  };
};
