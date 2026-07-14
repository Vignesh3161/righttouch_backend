// Get all users by role
export const getAllUsers = async (req, res) => {
  try {
    const { role } = req.params;
    const { search } = req.query;

    if (!role) {
      return res.status(400).json({ success: false, message: "Role is required", result: {} });
    }

    // Build search filter (applied to User-level fields)
    const searchMatch = {};
    if (search && search.trim().length >= 2) {
      const searchRegex = { $regex: search.trim(), $options: "i" };
      searchMatch.$or = [
        { mobileNumber: searchRegex },
        { fname: searchRegex },
        { lname: searchRegex },
        { email: searchRegex },
      ];
    }

    let users;

    if (role === "Customer") {

      // Enhanced Customer aggregation with booking stats and addresses
      users = await User.aggregate([
        {
          $match: { role: "Customer", ...searchMatch }
        },
        {
          $lookup: {
            from: "servicebookings",
            localField: "_id",
            foreignField: "customerId",
            as: "serviceBookings"
          }
        },
        {
          $lookup: {
            from: "productbookings",
            localField: "_id",
            foreignField: "userId",
            as: "productBookings"
          }
        },
        {
          $lookup: {
            from: "addresses",
            localField: "_id",
            foreignField: "customerId",
            as: "customerAddresses"
          }
        },
        {
          $project: {
            _id: 1,
            mobileNumber: 1,
            email: 1,
            status: 1,
            createdAt: 1,
            lastLoginAt: 1,
            profile: {
              fname: { $ifNull: ["$fname", ""] },
              lname: { $ifNull: ["$lname", ""] },
              gender: { $ifNull: ["$gender", ""] },
              profileComplete: { $ifNull: ["$profileComplete", false] }
            },
            addresses: {
              $map: {
                input: "$customerAddresses",
                as: "addr",
                in: {
                  _id: "$$addr._id",
                  label: "$$addr.label",
                  name: "$$addr.name",
                  phone: "$$addr.phone",
                  addressLine: "$$addr.addressLine",
                  city: "$$addr.city",
                  state: "$$addr.state",
                  pincode: "$$addr.pincode",
                  latitude: "$$addr.latitude",
                  longitude: "$$addr.longitude",
                  isDefault: "$$addr.isDefault",
                  createdAt: "$$addr.createdAt"
                }
              }
            },
            jobStats: {
              service: {
                total: { $size: "$serviceBookings" },
                completed: {
                  $size: {
                    $filter: {
                      input: "$serviceBookings",
                      as: "booking",
                      cond: { $eq: ["$$booking.status", "completed"] }
                    }
                  }
                },
                cancelled: {
                  $size: {
                    $filter: {
                      input: "$serviceBookings",
                      as: "booking",
                      cond: { $eq: ["$$booking.status", "cancelled"] }
                    }
                  }
                }
              },
              product: {
                total: { $size: "$productBookings" }
              }
            }
          }
        },
        {
          $sort: { createdAt: -1 }
        }
      ]);

    } else if (role === "Technician") {
      // Enhanced Technician aggregation with full profile, KYC, and job stats
      users = await User.aggregate([
        {
          $match: { role: "Technician", ...searchMatch }
        },
        {
          $lookup: {
            from: "technicianprofiles",
            localField: "_id",
            foreignField: "userId",
            as: "techProfile"
          }
        },
        {
          $unwind: {
            path: "$techProfile",
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $lookup: {
            from: "techniciankycs",
            localField: "techProfile._id",
            foreignField: "technicianId",
            as: "kycData"
          }
        },
        {
          $unwind: {
            path: "$kycData",
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $lookup: {
            from: "servicebookings",
            localField: "techProfile._id",
            foreignField: "technicianId",
            as: "jobs"
          }
        },
        {
          $lookup: {
            from: "services",
            localField: "techProfile.skills.serviceId",
            foreignField: "_id",
            as: "skillsData"
          }
        },
        {
          $project: {
            _id: 1,
            mobileNumber: 1,
            email: 1,
            createdAt: 1,
            lastLoginAt: 1,
            profile: {
              fname: {
                $cond: [
                  { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ["$fname", ""] } } } }, 0] },
                  "$fname",
                  {
                    $let: {
                      vars: { name: { $ifNull: ["$kycData.bankDetails.accountHolderName", ""] } },
                      in: {
                        $cond: [
                          { $gt: [{ $strLenCP: { $trim: { input: "$$name" } } }, 0] },
                          { $arrayElemAt: [{ $split: ["$$name", " "] }, 0] },
                          ""
                        ]
                      }
                    }
                  }
                ]
              },
              lname: {
                $cond: [
                  { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ["$lname", ""] } } } }, 0] },
                  "$lname",
                  {
                    $let: {
                      vars: { name: { $ifNull: ["$kycData.bankDetails.accountHolderName", ""] } },
                      in: {
                        $cond: [
                          { $gt: [{ $strLenCP: { $trim: { input: "$$name" } } }, 0] },
                          { $arrayElemAt: [{ $split: ["$$name", " "] }, 1] },
                          ""
                        ]
                      }
                    }
                  }
                ]
              },
              experienceYears: { $ifNull: ["$techProfile.experienceYears", 0] },
              specialization: { $ifNull: ["$techProfile.specialization", ""] },
              profileComplete: { $ifNull: ["$techProfile.profileComplete", false] },
              skills: {
                $ifNull: [
                  {
                    $map: {
                      input: "$techProfile.skills",
                      as: "skill",
                      in: {
                        serviceId: "$$skill.serviceId",
                        experienceYears: "$$skill.experienceYears",
                        serviceName: {
                          $let: {
                            vars: {
                              matchedService: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$skillsData",
                                      as: "svc",
                                      cond: { $eq: ["$$svc._id", "$$skill.serviceId"] }
                                    }
                                  },
                                  0
                                ]
                              }
                            },
                            in: { $ifNull: ["$$matchedService.name", ""] }
                          }
                        }
                      }
                    }
                  },
                  []
                ]
              }
            },
            kyc: {
              $cond: {
                if: { $ne: ["$kycData", null] },
                then: {
                  aadhaarNumber: { $ifNull: ["$kycData.aadhaarNumber", null] },
                  panNumber: { $ifNull: ["$kycData.panNumber", null] },
                  drivingLicenseNumber: { $ifNull: ["$kycData.drivingLicenseNumber", null] },
                  verificationStatus: { $ifNull: ["$kycData.verificationStatus", "pending"] },
                  kycVerified: { $ifNull: ["$kycData.kycVerified", false] },
                  rejectionReason: { $ifNull: ["$kycData.rejectionReason", null] },
                  documents: {
                    aadhaarUrl: { $ifNull: ["$kycData.documents.aadhaarUrl", null] },
                    panUrl: { $ifNull: ["$kycData.documents.panUrl", null] },
                    dlUrl: { $ifNull: ["$kycData.documents.dlUrl", null] }
                  }
                },
                else: null
              }
            },
            bankDetails: {
              $cond: {
                if: { $ne: ["$kycData.bankDetails", null] },
                then: {
                  accountHolderName: { $ifNull: ["$kycData.bankDetails.accountHolderName", null] },
                  bankName: { $ifNull: ["$kycData.bankDetails.bankName", null] },
                  ifscCode: { $ifNull: ["$kycData.bankDetails.ifscCode", null] },
                  upiId: { $ifNull: ["$kycData.bankDetails.upiId", null] },
                  bankVerified: { $ifNull: ["$kycData.bankVerified", false] },
                  bankUpdateRequired: { $ifNull: ["$kycData.bankUpdateRequired", false] }
                },
                else: null
              }
            },
            training: {
              trainingCompleted: { $ifNull: ["$techProfile.trainingCompleted", false] },
              workStatus: { $ifNull: ["$techProfile.workStatus", "pending"] },
              approvedAt: { $ifNull: ["$techProfile.approvedAt", null] }
            },
            availability: {
              isOnline: { $ifNull: ["$techProfile.availability.isOnline", false] },
              lastSeen: { $ifNull: ["$techProfile.lastSeen", null] }
            },
            rating: {
              avg: { $ifNull: ["$techProfile.rating.avg", 0] },
              count: { $ifNull: ["$techProfile.rating.count", 0] }
            },
            jobStats: {
              accepted: {
                $size: {
                  $filter: {
                    input: "$jobs",
                    as: "job",
                    cond: {
                      $in: ["$$job.status", ["accepted", "on_the_way", "reached", "in_progress", "completed"]]
                    }
                  }
                }
              },
              completed: {
                $size: {
                  $filter: {
                    input: "$jobs",
                    as: "job",
                    cond: { $eq: ["$$job.status", "completed"] }
                  }
                }
              },
              cancelled: {
                $size: {
                  $filter: {
                    input: "$jobs",
                    as: "job",
                    cond: { $eq: ["$$job.status", "cancelled"] }
                  }
                }
              }
            }
          }
        },
        {
          $sort: { createdAt: -1 }
        }
      ]);

    } else {
      // For other roles (Owner, Admin), return basic info
      users = await User.find({ role, ...searchMatch }).select("-password");
    }

    return res.status(200).json({ success: true, message: "Users fetched", result: users });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

// Get user by id and role
export const getUserById = async (req, res) => {
  try {
    const { role, id } = req.params;
    if (!role || !id) {
      return res.status(400).json({ success: false, message: "Role and id are required", result: {} });
    }
    const user = await User.findOne({ _id: id, role });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found", result: {} });
    }
    return res.status(200).json({ success: true, message: "User fetched", result: user });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* ================= DELETE USER BY ID (OWNER ONLY - SOFT DELETE) ================= */
export const deleteUserById = async (req, res) => {
  try {
    // 🛡️ Owner-only access
    if (req.user?.role !== "Owner") {
      return res.status(403).json({ success: false, message: "Owner access only", result: {} });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid user ID", result: {} });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found", result: {} });
    }

    if (user.status === "Deleted") {
      return res.status(400).json({ success: false, message: "User already deleted", result: {} });
    }

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // 🧹 Personal Data Cleanup (Requested Schemas Only)
      await Address.deleteMany({ customerId: id }).session(session);
      await Address.deleteMany({ userId: id }).session(session);

      if (user.role === "Technician") {
        const techProfile = await TechnicianProfile.findOne({ userId: id })
          .select("_id")
          .session(session);

        if (techProfile) {
          // Update all ServiceBookings with technician snapshot before deletion
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

          // Hard delete associated technician data
          await TechnicianProfile.deleteOne({ _id: techProfile._id }).session(session);
          await TechnicianKyc.deleteOne({ technicianId: techProfile._id }).session(session);
        }
      }

      // Final cleanup for any user-related OTP/Temp records
      await Otp.deleteMany({ identifier: user.mobileNumber }).session(session);
      await TempUser.deleteMany({ identifier: user.mobileNumber }).session(session);

      // HARD DELETE User record
      await User.deleteOne({ _id: id }).session(session);
    });
    session.endSession();

    console.log(`🗑️ Admin soft-deleted user ${id} (role: ${user.role})`);

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
      result: { deletedUserId: id, role: user.role },
    });
  } catch (err) {
    console.error("deleteUserById Error:", err);
    return res.status(500).json({ success: false, message: "Server error", result: { error: err.message } });
  }
};

// Owner and Technician login functions using passwords have been removed/replaced by OTP flows.
// See the OTP-based wrappers further down in the file.


// 🔍 DEBUG: Check if user exists by mobile number
// 🔍 DEBUG: Check if user exists by identifier
export const checkUserByIdentifier = async (req, res) => {
  try {
    const { identifier } = req.params;
    if (!identifier) {
      return res.status(400).json({ success: false, message: "Identifier required", result: {} });
    }

    const user = await User.findOne({ mobileNumber: identifier }).select("+password _id role fname lname mobileNumber email status createdAt");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found with this identifier",
        result: { identifier }
      });
    }

    const hasPassword = !!user.password;
    const techProfile = await TechnicianProfile.findOne({ userId: user._id }).select("_id workStatus");

    // Remove password from response
    const userObj = user.toObject();
    delete userObj.password;

    return res.status(200).json({
      success: true,
      message: "User found",
      result: {
        user: userObj,
        hasPassword,
        hasTechnicianProfile: !!techProfile,
        technicianProfile: techProfile || null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import Otp from "../Schemas/Otp.js";
import TempUser from "../Schemas/TempUser.js";

import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import Address from "../Schemas/Address.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import crypto from "crypto";

import sendSms from "../Utils/sendSMS.js";

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
    result: {},
    ...(code ? { error: { code, ...(details !== undefined ? { details } : {}) } } : {}),
  });

/* ======================================================
  CONSTANTS & HELPERS
====================================================== */

// roleModelMap removed. Only TechnicianProfile is used for technician extra data.

const generateOtp = () =>
  Math.floor(1000 + Math.random() * 9000).toString();

const toFiniteNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const passwordRegex =
  /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

const normalizeRole = (role) => {
  if (!role) return null;
  const normalized = role.toString().trim().toLowerCase();
  if (["owner", "admin", "customer", "technician"].includes(normalized)) {
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return null;
};

const findAnyProfileByMobileNumber = async (mobileNumber) => {
  const exists = await User.findOne({ mobileNumber }).select("_id");
  return !!exists;
};

// applyRolePopulates removed. Only used for TechnicianProfile in profile APIs if needed.

// Helper to build GeoJSON Point
const buildLocation = (lat, lng) => {
  if (
    typeof lat === "number" && typeof lng === "number" &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  ) {
    return { type: "Point", coordinates: [lng, lat] };
  }
  return null;
};

/* ======================================================
  1️⃣ SIGNUP + SEND OTP (SMS ONLY)
====================================================== */
export const signupAndSendOtp = async (req, res) => {
  try {
    let { identifier, role, termsAndServices, privacyPolicy } = req.body;

    role = normalizeRole(role);
    identifier = identifier?.trim();

    if (!identifier || !role) {
      return fail(res, 400, "Identifier and role required", "VALIDATION_ERROR", {
        required: ["identifier", "role"],
      });
    }

    // Validate terms and privacy acceptance (required for Customer and Technician)
    if (role === "Customer" || role === "Technician") {
      const missing = [];
      if (termsAndServices !== true) missing.push("termsAndServices");
      if (privacyPolicy !== true) missing.push("privacyPolicy");

      if (missing.length > 0) {
        return fail(
          res,
          400,
          `You must accept ${missing.join(" and ")} to continue`,
          "TERMS_OR_PRIVACY_NOT_ACCEPTED",
          {
            required: ["termsAndServices", "privacyPolicy"],
            message: "Both termsAndServices and privacyPolicy must be true"
          }
        );
      }
    }

    // Prevent re-registering an existing mobile number (across any role)
    // Note: We still treat identifier as mobileNumber for database storage in User model
    const existingUser = await User.findOne({ mobileNumber: identifier }).select("_id status role");

    if (existingUser) {
      // 🧟 SELF-HEALING: If user is "Deleted" but still holds the number, free it up!
      if (existingUser.status === "Deleted") {
        console.log(`♻️ Found zombie deleted user ${existingUser._id}. Anonymizing mobile to free up ${identifier}...`);
        const timestamp = Date.now();
        const anonymizedMobile = `deleted_${existingUser._id}_${timestamp}`;
        const anonymizedEmail = `deleted_${existingUser._id}_${timestamp}@example.invalid`;

        await User.updateOne(
          { _id: existingUser._id },
          {
            $set: {
              mobileNumber: anonymizedMobile,
              email: anonymizedEmail
            }
          }
        );
        // Proceed with signup as if number was free
      } else {
        // Active user found
        const message =
          existingUser.role === "Technician"
            ? `Mobile number already registered as a Technician. Please login with your technician account.`
            : `Mobile number already registered as a Customer. Please login with your Customer account.`;

        return fail(res, 409, message, "MOBILE_ALREADY_EXISTS", { identifier, existingRole: existingUser.role });
      }
    }

    // Step 1: Create / update temp user (FIRST)
    const updateFields = {
      identifier,
      role,
      tempstatus: "Pending"
    };

    // If terms/privacy were accepted, persist them in temp storage
    if (termsAndServices === true) {
      updateFields.termsAndServices = true;
      updateFields.termsAndServicesAt = new Date();
    }
    if (privacyPolicy === true) {
      updateFields.privacyPolicy = true;
      updateFields.privacyPolicyAt = new Date();
    }

    const tempUser = await TempUser.findOneAndUpdate(
      { identifier, role },
      updateFields,
      { upsert: true, new: true }
    );

    if (!tempUser) {
      return fail(res, 500, "Failed to create signup record", "TEMPUSER_CREATE_FAILED");
    }

    // Step 2: Remove old OTPs
    await Otp.deleteMany({
      identifier,
      role,
      purpose: "SIGNUP",
    });

    // Step 3: Generate and hash OTP
    const otp = generateOtp();
    console.log(otp)
    const hashedOtp = await bcrypt.hash(otp, 10);
    // Step 4: Store OTP
    await Otp.create({
      identifier,
      role,
      purpose: "SIGNUP",
      otp: hashedOtp,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
    });

    // Step 5: SEND OTP VIA SMS (AFTER storing in database)
    try {
      await sendSms(identifier, otp);
    } catch (smsErr) {
      console.error("SMS sending failed:", smsErr.message);
      // OTP is stored, SMS will retry or user can request resend
      return fail(res, 500, "Failed to send OTP. Please try again.", "SMS_SEND_FAILED");
    }

    return ok(res, 200, "OTP sent successfully", {
      identifier,
      role,
      purpose: "SIGNUP",
      expiresInSeconds: 300,
    });
  } catch (err) {
    return fail(res, 500, err.message || "Internal server error", "SERVER_ERROR");
  }
};


/* ======================================================
  2️⃣ RESEND OTP (COMMON)
====================================================== */
export const resendOtp = async (req, res) => {
  try {
    const { identifier, mobileNumber } = req.body;
    const finalIdentifier = (identifier || mobileNumber)?.trim();

    if (!finalIdentifier) {
      return fail(res, 400, "Identifier (mobile number) required", "VALIDATION_ERROR");
    }

    // 1. Find the latest OTP record for this identifier to infer role and purpose
    // This is the most reliable way to follow the user's just-started flow (Login or Signup)
    const lastOtp = await Otp.findOne({ identifier: finalIdentifier }).sort({ createdAt: -1 });

    if (!lastOtp) {
      return fail(res, 404, "No recent OTP found. Please login or signup again.", "OTP_NOT_FOUND");
    }

    // ⏳ 60 sec cooldown check
    if (Date.now() - lastOtp.createdAt < 60 * 1000) {
      return fail(res, 429, "Please wait before retrying", "OTP_COOLDOWN");
    }

    const { role, purpose } = lastOtp;

    // 2. Safety Check for Owner: Owner only uses OTP for SIGNUP (signin), not for login
    if (role === "Owner" && purpose !== "SIGNUP") {
      return fail(res, 403, "Owner can only resend OTP for signup", "FORBIDDEN");
    }

    // Standard for Customer/Technician: both LOGIN and SIGNUP work naturally here

    // Remove old OTPs for this identifier/role/purpose to keep DB clean
    await Otp.deleteMany({
      identifier: finalIdentifier,
      role,
      purpose,
    });

    // Generate and hash new OTP
    let otp = generateOtp();
    if (finalIdentifier === "9876543210" || finalIdentifier === "9090909090") otp = "3161"; // [TESTING_ONLY]
    const hashedOtp = await bcrypt.hash(otp, 10);

    // Store new OTP
    await Otp.create({
      identifier: finalIdentifier,
      role,
      purpose,
      otp: hashedOtp,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
    });

    // Send SMS
    try {
      await sendSms(finalIdentifier, otp);
    } catch (smsErr) {
      console.error("SMS sending failed:", smsErr.message);
      return fail(res, 500, "Failed to send OTP. Please try again.", "SMS_SEND_FAILED");
    }

    return ok(res, 200, "OTP resent successfully", {
      identifier: finalIdentifier,
      role,
      purpose,
      expiresInSeconds: 300,
      cooldownSeconds: 60,
    });
  } catch (err) {
    console.error("resendOtp Error:", err);
    return fail(res, 500, "Internal server error", "SERVER_ERROR");
  }
};


/* ======================================================
  3️⃣ VERIFY OTP
====================================================== */
/* ======================================================
  3️⃣ VERIFY OTP (UNIFIED: SIGNUP & LOGIN)
====================================================== */
export const verifyOtp = async (req, res) => {
  try {
    // Standardize input: accept identifier (or mobileNumber for backward compat)
    let { identifier, mobileNumber, otp, role } = req.body;
    const finalIdentifier = (identifier || mobileNumber)?.trim();
    // Role is optional here if we can infer from OTP, but safer to validate if provided
    const normalizedRole = role ? normalizeRole(role) : null;

    if (!finalIdentifier || !otp) {
      return fail(res, 400, "Identifier and OTP required", "VALIDATION_ERROR", {
        required: ["identifier", "otp"],
      });
    }

    // 1. Find the OTP record (valid, not verified, not expired)
    // We search by identifier. If role is provided, restrict to that role.
    const query = {
      identifier: finalIdentifier,
      verified: false,
      otp: { $exists: true }, // Ensure OTP field exists
      expiresAt: { $gte: Date.now() },
    };
    // // if (normalizedRole) {
    // //   query.role = normalizedRole;
    // // }
    //----------------------->new chnages

    // Sort by createdAt desc to get the latest OTP
    let record = await Otp.findOne(query).sort({ createdAt: -1 });

    // [TESTING_ONLY] Bypass for fixed number and OTP
    if (!record && (finalIdentifier === "9876543210" || finalIdentifier === "9090909090") && otp === "3161") {
      record = {
        identifier: finalIdentifier,
        otp: await bcrypt.hash("3161", 10),
        role: normalizedRole || "Customer",
        purpose: "LOGIN",
        verified: false,
        attempts: 0,
        _id: new mongoose.Types.ObjectId(),
      };
    }

    if (!record) {
      return fail(res, 400, "OTP expired, invalid, or already used", "OTP_INVALID_OR_EXPIRED");
    }

    if (record.attempts >= 5) {
      return fail(res, 429, "Too many attempts. Request new OTP.", "OTP_TOO_MANY_ATTEMPTS");
    }

    // 2. Verify OTP
    const isMatch = await bcrypt.compare(otp, record.otp);
    if (!isMatch) {
      await Otp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
      const remainingAttempts = Math.max(0, 5 - (record.attempts + 1));
      return fail(res, 400, `Invalid OTP. ${remainingAttempts} attempts remaining`, "OTP_INVALID", {
        attemptsRemaining: remainingAttempts,
      });
    }

    // 3. Mark OTP as verified
    await Otp.updateOne({ _id: record._id }, { $set: { verified: true } });

    // 4. Branch Logic based on Purpose
    if (record.purpose === "SIGNUP") {
      // --- SIGNUP COMPLETION LOGIC ---
      const tempUser = await TempUser.findOne({ identifier: finalIdentifier, role: record.role });
      if (!tempUser) {
        return fail(res, 404, "No signup request found. Please signup first.", "TEMPUSER_NOT_FOUND");
      }

      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const userDoc = await User.create([
          {
            role: record.role,
            mobileNumber: finalIdentifier,
            status: "Active",
            termsAndServices: tempUser.termsAndServices || false,
            privacyPolicy: tempUser.privacyPolicy || false,
            termsAndServicesAt: tempUser.termsAndServicesAt || null,
            privacyPolicyAt: tempUser.privacyPolicyAt || null,
          },
        ], { session });
        const user = userDoc[0];

        let technicianProfile = null;
        if (record.role === "Technician") {
          technicianProfile = await TechnicianProfile.create([
            {
              userId: user._id,
              location: null,
              workStatus: "pending",
              profileComplete: false,
            },
          ], { session });
        }

        // Cleanup
        await TempUser.deleteOne({ identifier: finalIdentifier, role: record.role }, { session });
        await Otp.deleteMany({ identifier: finalIdentifier, role: record.role }, { session });

        await session.commitTransaction();
        session.endSession();

        // Generate Token
        const tokenPayload = {
          userId: user._id,
          role: record.role,
        };
        if (technicianProfile && technicianProfile[0]) {
          tokenPayload.technicianProfileId = technicianProfile[0]._id;
        }
        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: "30d" });

        return ok(res, 201, "Account created successfully", {
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
        });
      } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err; // Re-throw to outer catch
      }

    } else if (record.purpose === "LOGIN") {
      // --- LOGIN COMPLETION LOGIC ---
      const user = await User.findOne({ mobileNumber: finalIdentifier, role: record.role });
      if (!user) {
        return fail(res, 404, "User account not found.", "USER_NOT_FOUND");
      }

      if (user.status === "Deleted") {
        return fail(res, 403, "Account deleted", "ACCOUNT_DELETED");
      }

      if (user.role === "Technician") {
        const techProfile = await TechnicianProfile.findOne({ userId: user._id }).select("workStatus");
        if (techProfile?.workStatus === "deleted") {
          return fail(res, 403, "Account deleted", "ACCOUNT_DELETED");
        }
      }

      // Update lastLoginAt
      await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

      // Clean up used OTP
      await Otp.deleteOne({ _id: record._id });

      // Get technician profile if applicable
      let technicianProfileId = null;
      if (user.role === "Technician") {
        const tech = await TechnicianProfile.findOne({ userId: user._id }).select("_id");
        technicianProfileId = tech?._id || null;
      }

      // Generate Token
      const token = jwt.sign(
        {
          userId: user._id,
          role: user.role,
          technicianProfileId,
        },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
      );

      return ok(res, 200, "Login successful", {
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
      });

    } else {
      return fail(res, 400, "Invalid OTP purpose", "OTP_PURPOSE_INVALID");
    }

  } catch (err) {
    console.error("verifyOtp Error:", err);
    return fail(res, 500, err.message || "Internal server error", "SERVER_ERROR");
  }
};

/* ======================================================
  4️⃣ SET PASSWORD (For Owners) - Authenticated
====================================================== */
export const setPassword = async (req, res) => {
  try {
    const { password } = req.body;
    const { userId } = req.user; // From Auth middleware

    if (!userId) {
      return fail(res, 401, "Unauthorized", "UNAUTHORIZED");
    }

    if (!password) {
      return fail(res, 400, "Password is required", "VALIDATION_ERROR");
    }

    if (password.length < 8) {
      return fail(res, 400, "Password must be at least 8 characters long", "VALIDATION_ERROR");
    }

    const user = await User.findById(userId);

    if (!user) {
      return fail(res, 404, "User not found", "USER_NOT_FOUND");
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);
    user.password = hashedPassword;
    await user.save();

    return ok(res, 200, "Password set successfully");
  } catch (err) {
    return fail(res, 500, err.message, "SERVER_ERROR");
  }
};

/* ======================================================
  5️⃣ LOGIN (Hybrid: Password for Owner, OTP for Cust/Tech)
====================================================== */
export const login = async (req, res) => {
  try {
    const { identifier, mobileNumber, role, password } = req.body;
    const finalIdentifier = (identifier || mobileNumber)?.trim();
    const normalizedRole = normalizeRole(role);

    if (!finalIdentifier) {
      return fail(res, 400, "Identifier (Mobile Number) required", "VALIDATION_ERROR");
    }
    if (!normalizedRole) {
      return fail(res, 400, "Valid role required", "VALIDATION_ERROR");
    }

    // Check if user exists (ignoring role initially to give better error)
    const user = await User.findOne({ mobileNumber: finalIdentifier }).select("+password role status");

    if (!user) {
      return fail(res, 404, "User not found. Please signup first.", "USER_NOT_FOUND");
    }

    // Role Mismatch Check
    if (user.role !== normalizedRole) {
      return fail(
        res,
        403,
        `This account is registered as a ${user.role}. Please use the ${user.role} app to login.`,
        "ROLE_MISMATCH",
        { registeredRole: user.role, requestedRole: normalizedRole }
      );
    }

    if (user.status === "Blocked") {
      return fail(res, 403, "Account is blocked. Please contact support.", "ACCOUNT_BLOCKED");
    }

    if (user.status === "Deleted") {
      return fail(res, 403, "Account deleted", "ACCOUNT_DELETED");
    }

    if (normalizedRole === "Technician") {
      const techProfile = await TechnicianProfile.findOne({ userId: user._id }).select("workStatus");
      if (techProfile?.workStatus === "deleted") {
        return fail(res, 403, "Account deleted", "ACCOUNT_DELETED");
      }
    }

    // --- OWNER LOGIN (PASSWORD) ---
    if (normalizedRole === "Owner" && user.password) {
      if (!password) {
        return fail(res, 400, "Password is required for Owner login", "PASSWORD_REQUIRED");
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return fail(res, 401, "Invalid password", "INVALID_CREDENTIALS");
      }

      // Login Successful
      await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

      const token = jwt.sign(
        { userId: user._id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
      );

      return ok(res, 200, "Login successful", {
        token,
        userId: user._id,
        role: user.role,
      });
    }

    // --- CUSTOMER / TECHNICIAN LOGIN (OTP) ---
    else {
      // Remove old login OTPs
      await Otp.deleteMany({
        identifier: finalIdentifier,
        role: normalizedRole,
        purpose: "LOGIN",
      });

      // Generate and hash OTP
      let otp = generateOtp();
      if (finalIdentifier === "9876543210" || finalIdentifier === "9090909090") otp = "3161"; // [TESTING_ONLY]
      const hashedOtp = await bcrypt.hash(otp, 10);

      // Store OTP
      await Otp.create({
        identifier: finalIdentifier,
        role: normalizedRole,
        purpose: "LOGIN",
        otp: hashedOtp,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      // Send SMS
      try {
        await sendSms(finalIdentifier, otp);
      } catch (smsErr) {
        console.error("SMS sending failed:", smsErr.message);
        return fail(res, 500, "Failed to send OTP. Please try again.", "SMS_SEND_FAILED");
      }

      return ok(res, 200, "OTP sent successfully", {
        identifier: finalIdentifier,
        role: normalizedRole,
        purpose: "LOGIN",
        expiresInSeconds: 300,
      });
    }

  } catch (err) {
    return fail(res, 500, err.message, "SERVER_ERROR");
  }
};

/* ======================================================
  ROLE-SPECIFIC LOGIN WRAPPERS
====================================================== */

export const ownerLogin = async (req, res) => {
  req.body.role = "Owner";
  return login(req, res);
};

export const technicianLogin = async (req, res) => {
  req.body.role = "Technician";
  return login(req, res);
};

export const customerLogin = async (req, res) => {
  req.body.role = "Customer";
  return login(req, res);
};

/* ======================================================
  ROLE-SPECIFIC VERIFY OTP WRAPPERS
====================================================== */

export const verifyCustomerOtp = async (req, res) => {
  req.body.role = "Customer";
  return verifyOtp(req, res);
};

export const verifyTechnicianOtp = async (req, res) => {
  req.body.role = "Technician";
  return verifyOtp(req, res);
};

// Unified login OTP request endpoint wrapper (used by routes)
export const requestLoginOtp = async (req, res) => {
  // Delegates to `login` which handles Owner (password) and OTP flows for others
  return login(req, res);
};

// Unified login OTP verify endpoint wrapper (used by routes)
export const verifyLoginOtp = async (req, res) => {
  // Delegates to `verifyOtp` which supports LOGIN purpose
  return verifyOtp(req, res);
};

/* ======================================================
  6️⃣ PASSWORD RESET FLOW
====================================================== */

/* ======================================================
  7️⃣ PROFILE APIs
====================================================== */
export const getMyProfile = async (req, res) => {
  const { userId, role } = req.user;
  if (!userId || !role) {
    return fail(res, 401, "Unauthorized", "UNAUTHORIZED");
  }
  if (role === "Technician") {
    const profile = await TechnicianProfile.findOne({ userId })
      .populate({
        path: "userId",
        select: "fname lname gender mobileNumber email",
      })
      .select("-password");
    if (!profile) return fail(res, 404, "Profile not found", "PROFILE_NOT_FOUND");
    const result = profile.toObject();
    // Optionally fetch KYC
    const kyc = await TechnicianKyc.findOne({ technicianId: profile._id }).select("bankDetails bankVerified bankUpdateRequired");
    if (kyc && kyc.bankDetails) {
      result.bankDetails = kyc.bankDetails;
      result.bankVerified = kyc.bankVerified || false;
      result.bankUpdateRequired = kyc.bankUpdateRequired || false;
    }
    return ok(res, 200, "Profile fetched successfully", result);
  } else {
    const user = await User.findById(userId).select("-password");
    if (!user) return fail(res, 404, "User not found", "USER_NOT_FOUND");
    return ok(res, 200, "Profile fetched successfully", user.toObject());
  }
};

export const completeProfile = async (req, res) => {
  const { userId, role } = req.user;
  if (!userId || !role) {
    return fail(res, 401, "Unauthorized", "UNAUTHORIZED");
  }
  let allowedFields = [];
  if (role === "Technician") {
    allowedFields = [
      "fname",
      "lname",
      "gender",
      "address",
      "city",
      "state",
      "pincode",
      "latitude",
      "longitude",
      "locality",
      "experienceYears",
      "specialization",
    ];
    const updateData = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });
    const userUpdateData = {};
    if (req.body.fname !== undefined) {
      userUpdateData.fname = req.body.fname;
    }
    if (req.body.lname !== undefined) {
      userUpdateData.lname = req.body.lname;
    }
    if (req.body.gender !== undefined) {
      userUpdateData.gender = req.body.gender;
    }
    // Technician geo location (optional) -> stored as GeoJSON Point + display strings
    if (updateData.latitude !== undefined || updateData.longitude !== undefined) {
      const latString = updateData.latitude;
      const lngString = updateData.longitude;
      updateData.latitude = latString;
      updateData.longitude = lngString;
      const lat = toFiniteNumber(latString);
      const lng = toFiniteNumber(lngString);
      const loc = buildLocation(lat, lng);
      if (loc) updateData.location = loc;
    }
    updateData.profileComplete = true;
    if (Object.keys(userUpdateData).length > 0) {
      await User.findByIdAndUpdate(userId, userUpdateData, { new: true, runValidators: true });
    }
    const updated = await TechnicianProfile.findOneAndUpdate(
      { userId },
      updateData,
      { new: true, runValidators: true }
    ).select("-password");
    return ok(res, 200, "Profile completed successfully", updated || {});
  } else {
    allowedFields = ["fname", "lname", "gender", "email"];
    const updateData = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });
    // Mark profile as complete after filling required fields
    updateData.profileComplete = true;
    const updated = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    ).select("-password");
    return ok(res, 200, "Profile completed successfully", updated || {});
  }
};

/**
 * @desc    Accept Terms and Conditions for an authenticated user
 * @route   POST /api/user/auth/accept-terms
 * @access  Private (Authenticated)
 */
export const acceptTerms = async (req, res) => {
  try {
    const { userId } = req.user;
    if (!userId) {
      return fail(res, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const { termsAndServices, privacyPolicy } = req.body;

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
      return fail(res, 400, "Provide either termsAndServices: true or privacyPolicy: true", "VALIDATION_ERROR");
    }

    const user = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true }
    ).select("-password");

    if (!user) {
      return fail(res, 404, "User not found", "USER_NOT_FOUND");
    }

    return ok(res, 200, "Terms or Privacy Policy updated successfully", {
      termsAndServices: user.termsAndServices,
      privacyPolicy: user.privacyPolicy,
      termsAndServicesAt: user.termsAndServicesAt,
      privacyPolicyAt: user.privacyPolicyAt,
    });
  } catch (err) {
    return fail(res, 500, err.message, "SERVER_ERROR");
  }
};


export const updateMyProfile = async (req, res) => {
  const { userId, role } = req.user;
  if (!userId || !role) {
    return fail(res, 401, "Unauthorized", "UNAUTHORIZED");
  }
  // Technician can update bank details here (stored in TechnicianKyc)
  if (role === "Technician" && req.body?.bankDetails) {
    const technicianProfile = await TechnicianProfile.findOne({ userId });
    if (!technicianProfile) return fail(res, 404, "Technician profile not found", "PROFILE_NOT_FOUND");
    const bankDetails = req.body.bankDetails || {};
    let kyc = await TechnicianKyc.findOne({ technicianId: technicianProfile._id });
    if (!kyc) {
      kyc = new TechnicianKyc({ technicianId: technicianProfile._id });
    }
    if (kyc.bankVerified && !kyc.bankUpdateRequired) {
      return fail(res, 403, "Bank details are verified and cannot be edited", "BANK_EDIT_BLOCKED");
    }
    const errors = [];
    if (bankDetails.accountHolderName && !/^[a-zA-Z\s]{3,}$/.test(bankDetails.accountHolderName)) {
      errors.push("Account holder name must be 3+ characters, alphabets and spaces only");
    }
    if (bankDetails.bankName && !/^[a-zA-Z\s]{3,}$/.test(bankDetails.bankName)) {
      errors.push("Bank name must be 3+ characters, alphabets and spaces only");
    }
    if (bankDetails.accountNumber && !/^\d{9,18}$/.test(bankDetails.accountNumber)) {
      errors.push("Account number must be 9-18 digits only");
    }
    if (bankDetails.ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(bankDetails.ifscCode).toUpperCase())) {
      errors.push("Invalid IFSC code format");
    }
    if (bankDetails.branchName && String(bankDetails.branchName).trim().length < 3) {
      errors.push("Branch name must be at least 3 characters");
    }
    if (bankDetails.upiId && !/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(bankDetails.upiId)) {
      errors.push("Invalid UPI ID format");
    }
    if (errors.length) {
      return fail(res, 400, "Invalid bank details", "VALIDATION_ERROR", { errors });
    }
    if (bankDetails.accountNumber) {
      const accountNumberHash = crypto
        .createHash("sha256")
        .update(String(bankDetails.accountNumber))
        .digest("hex");
      const dup = await TechnicianKyc.findOne({
        "bankDetails.accountNumberHash": accountNumberHash,
        technicianId: { $ne: technicianProfile._id },
      });
      if (dup) {
        return fail(res, 400, "Account number already registered with another technician", "DUPLICATE_ACCOUNT");
      }
    }
    const processed = {
      accountHolderName: bankDetails.accountHolderName
        ? String(bankDetails.accountHolderName)
          .toLowerCase()
          .split(" ")
          .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
          .join(" ")
        : bankDetails.accountHolderName,
      bankName: bankDetails.bankName ? String(bankDetails.bankName).trim() : bankDetails.bankName,
      accountNumber: bankDetails.accountNumber ? String(bankDetails.accountNumber).trim() : bankDetails.accountNumber,
      accountNumberHash: bankDetails.accountNumber
        ? crypto.createHash("sha256").update(String(bankDetails.accountNumber).trim()).digest("hex")
        : kyc.bankDetails?.accountNumberHash,
      ifscCode: bankDetails.ifscCode ? String(bankDetails.ifscCode).toUpperCase().trim() : bankDetails.ifscCode,
      branchName: bankDetails.branchName ? String(bankDetails.branchName).trim() : bankDetails.branchName,
      upiId: bankDetails.upiId ? String(bankDetails.upiId).toLowerCase().trim() : bankDetails.upiId,
    };
    kyc.bankDetails = { ...(kyc.bankDetails || {}), ...processed };
    kyc.bankVerified = false;
    kyc.bankUpdateRequired = false;
    kyc.bankVerificationStatus = "pending";
    kyc.bankEditableUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await kyc.save();
  }
  if (role === "Technician") {
    let allowedFields = [
      "fname",
      "lname",
      "gender",
      "address",
      "city",
      "state",
      "pincode",
      "latitude",
      "longitude",
      "locality",
      "experienceYears",
      "specialization",
    ];
    const updateData = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });
    if (updateData.latitude !== undefined || updateData.longitude !== undefined) {
      const latString = updateData.latitude;
      const lngString = updateData.longitude;
      updateData.latitude = latString;
      updateData.longitude = lngString;
      const lat = toFiniteNumber(latString);
      const lng = toFiniteNumber(lngString);
      const loc = buildLocation(lat, lng);
      if (loc) updateData.location = loc;
    }
    const updated = await TechnicianProfile.findOneAndUpdate(
      { userId },
      updateData,
      { new: true, runValidators: true }
    ).select("-password");
    return ok(res, 200, "Profile updated successfully", updated || {});
  } else {
    let allowedFields = ["fname", "lname", "gender", "email"];
    const forbidden = new Set(["password", "status", "userId", "profileComplete"]);
    const updateData = {};
    Object.keys(req.body || {}).forEach((k) => {
      if (!forbidden.has(k) && allowedFields.includes(k)) updateData[k] = req.body[k];
    });

    // Auto-calculate profileComplete: true if fname AND mobileNumber exist
    const currentUser = await User.findById(userId).select("fname lname mobileNumber");
    const finalFname = updateData.fname !== undefined ? updateData.fname : currentUser?.fname;
    const finalMobileNumber = currentUser?.mobileNumber;

    if (finalFname && finalMobileNumber) {
      updateData.profileComplete = true;
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    ).select("-password");
    return ok(res, 200, "Profile updated successfully", updated || {});
  }
};

// getUserById and getAllUsers removed: use User or TechnicianProfile directly in routes/controllers as needed.
// Trigger restart.
