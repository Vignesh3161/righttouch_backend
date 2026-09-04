import mongoose from "mongoose";
import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import Address from "../Schemas/Address.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import Otp from "../Schemas/Otp.js";
import TempUser from "../Schemas/TempUser.js";

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
      const user = await User.findById(userId).session(session);
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
        const activeOwners = await User.countDocuments({
          role: "Owner",
          status: "Active",
          _id: { $ne: userId },
        }).session(session);

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
        const techProfile = await TechnicianProfile.findOne({ userId })
          .select("_id")
          .session(session);

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

          await TechnicianProfile.deleteOne({ _id: techProfileId }).session(session);
          await TechnicianKyc.deleteOne({ technicianId: techProfileId }).session(session);
        }
      }

      await Otp.deleteMany({ identifier: user.mobileNumber }).session(session);
      await TempUser.deleteMany({ identifier: user.mobileNumber }).session(session);

      await User.deleteOne({ _id: userId }).session(session);
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

  const user = await User.findById(targetUserId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
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
        const techProfile = await TechnicianProfile.findOne({ userId: targetUserId })
          .select("_id")
          .session(session);

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

          await TechnicianProfile.deleteOne({ _id: techProfile._id }).session(session);
          await TechnicianKyc.deleteOne({ technicianId: techProfile._id }).session(session);
        }
      }

      await Otp.deleteMany({ identifier: user.mobileNumber }).session(session);
      await TempUser.deleteMany({ identifier: user.mobileNumber }).session(session);

      await User.deleteOne({ _id: targetUserId }).session(session);
    });

    return { deletedUserId: targetUserId, role: user.role };
  } catch (err) {
    throw err;
  } finally {
    session.endSession();
  }
};
