import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import { getDekForKycDoc, getOrCreateDekForKycDoc, encryptBankDetails, decryptBankDetails } from "../Utils/kycFieldCrypto.js";
import { hashAccountNumber } from "../Utils/kycPrivacy.js";
import { toPlaintext } from "../Utils/kycEncryption.js";
import { kmsDecryptDek } from "../Utils/kmsClient.js";

/**
 * Internal Profile Service
 * Handles user profile retrieval, update, completion, and admin user list aggregation.
 */

const toFiniteNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const buildLocation = (lat, lng) => {
  if (
    typeof lat === "number" && typeof lng === "number" &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  ) {
    return { type: "Point", coordinates: [lng, lat] };
  }
  return null;
};

/**
 * Decrypts KYC identity and bank fields for admin listing.
 */
const decryptAdminUserList = async (users) => {
  const techUsers = users.filter((u) => u.technicianId);
  if (techUsers.length === 0) return;
  const kycDocs = await TechnicianKyc.find({
    technicianId: { $in: techUsers.map((u) => u.technicianId) },
  })
    .select("technicianId encryptedDek")
    .lean();
  const dekByTech = new Map();
  for (const doc of kycDocs) {
    if (!doc.encryptedDek) continue;
    try {
      const dek = await kmsDecryptDek(doc.encryptedDek);
      dekByTech.set(doc.technicianId.toString(), dek);
    } catch (e) {
      console.error(`Failed to decrypt DEK for technician ${doc.technicianId}:`, e.message);
    }
  }
  for (const u of users) {
    const dek = u.technicianId ? dekByTech.get(u.technicianId.toString()) : undefined;
    if (!dek) continue;
    if (u.kyc) {
      u.kyc.aadhaarNumber = toPlaintext(u.kyc.aadhaarNumber, dek);
      u.kyc.panNumber = toPlaintext(u.kyc.panNumber, dek);
      u.kyc.drivingLicenseNumber = toPlaintext(u.kyc.drivingLicenseNumber, dek);
    }
    if (u.bankDetails) {
      u.bankDetails.accountHolderName = toPlaintext(u.bankDetails.accountHolderName, dek);
      u.bankDetails.ifscCode = toPlaintext(u.bankDetails.ifscCode, dek);
      u.bankDetails.upiId = toPlaintext(u.bankDetails.upiId, dek);
    }
  }
};

/**
 * Retrieves profile for authenticated user.
 */
export const getMyProfileInternal = async ({ userId, role }) => {
  if (!userId || !role) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "UNAUTHORIZED";
    throw err;
  }

  if (role === "Technician") {
    const profile = await TechnicianProfile.findOne({ userId })
      .populate({
        path: "userId",
        select: "fname lname gender mobileNumber email",
      })
      .select("-password");

    if (!profile) {
      const err = new Error("Profile not found");
      err.statusCode = 404;
      err.code = "PROFILE_NOT_FOUND";
      throw err;
    }

    const result = profile.toObject();
    const kyc = await TechnicianKyc.findOne({ technicianId: profile._id }).select(
      "bankDetails bankVerified bankUpdateRequired encryptedDek"
    );

    if (kyc && kyc.bankDetails) {
      const dek = await getDekForKycDoc(kyc);
      result.bankDetails = decryptBankDetails(kyc.bankDetails, dek);
      result.bankVerified = kyc.bankVerified || false;
      result.bankUpdateRequired = kyc.bankUpdateRequired || false;
    }
    return result;
  } else {
    const user = await User.findById(userId).select("-password");
    if (!user) {
      const err = new Error("User not found");
      err.statusCode = 404;
      err.code = "USER_NOT_FOUND";
      throw err;
    }
    return user.toObject();
  }
};

/**
 * Complete user profile.
 */
export const completeProfileInternal = async ({ userId, role, body }) => {
  if (!userId || !role) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "UNAUTHORIZED";
    throw err;
  }

  if (role === "Technician") {
    const allowedFields = [
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
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    });

    const userUpdateData = {};
    if (body.fname !== undefined) userUpdateData.fname = body.fname;
    if (body.lname !== undefined) userUpdateData.lname = body.lname;
    if (body.gender !== undefined) userUpdateData.gender = body.gender;

    if (updateData.latitude !== undefined || updateData.longitude !== undefined) {
      const latNum = toFiniteNumber(updateData.latitude);
      const lngNum = toFiniteNumber(updateData.longitude);
      const loc = buildLocation(latNum, lngNum);
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

    return updated || {};
  } else {
    const allowedFields = ["fname", "lname", "gender", "email"];
    const updateData = {};
    allowedFields.forEach((field) => {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    });

    updateData.profileComplete = true;

    const updated = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    ).select("-password");

    return updated || {};
  }
};

/**
 * Update user profile (including bank details for technicians).
 */
export const updateMyProfileInternal = async ({ userId, role, body }) => {
  if (!userId || !role) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "UNAUTHORIZED";
    throw err;
  }

  if (role === "Technician" && body?.bankDetails) {
    const technicianProfile = await TechnicianProfile.findOne({ userId });
    if (!technicianProfile) {
      const err = new Error("Technician profile not found");
      err.statusCode = 404;
      err.code = "PROFILE_NOT_FOUND";
      throw err;
    }

    const bankDetails = body.bankDetails || {};
    let kyc = await TechnicianKyc.findOne({ technicianId: technicianProfile._id });
    if (!kyc) {
      kyc = new TechnicianKyc({ technicianId: technicianProfile._id });
    }

    if (kyc.bankVerified && !kyc.bankUpdateRequired) {
      const err = new Error("Bank details are verified and cannot be edited");
      err.statusCode = 403;
      err.code = "BANK_EDIT_BLOCKED";
      throw err;
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
      const err = new Error("Invalid bank details");
      err.statusCode = 400;
      err.code = "VALIDATION_ERROR";
      err.details = { errors };
      throw err;
    }

    if (bankDetails.accountNumber) {
      const accountNumberHash = hashAccountNumber(bankDetails.accountNumber);
      const dup = await TechnicianKyc.findOne({
        $or: [
          { "bankDetails.accountNumberHash": accountNumberHash },
          { "bankDetails.accountNumber": String(bankDetails.accountNumber).trim() },
        ],
        technicianId: { $ne: technicianProfile._id },
      });
      if (dup) {
        const err = new Error("Account number already registered with another technician");
        err.statusCode = 400;
        err.code = "DUPLICATE_ACCOUNT";
        throw err;
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
        ? hashAccountNumber(bankDetails.accountNumber)
        : kyc.bankDetails?.accountNumberHash,
      ifscCode: bankDetails.ifscCode ? String(bankDetails.ifscCode).toUpperCase().trim() : bankDetails.ifscCode,
      branchName: bankDetails.branchName ? String(bankDetails.branchName).trim() : bankDetails.branchName,
      upiId: bankDetails.upiId ? String(bankDetails.upiId).toLowerCase().trim() : bankDetails.upiId,
    };

    const dek = await getOrCreateDekForKycDoc(kyc);
    kyc.bankDetails = { ...(kyc.bankDetails || {}), ...encryptBankDetails(processed, dek) };
    kyc.bankVerified = false;
    kyc.bankUpdateRequired = false;
    kyc.bankVerificationStatus = "pending";
    kyc.bankEditableUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await kyc.save();
  }

  if (role === "Technician") {
    const allowedFields = [
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
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    });
    if (updateData.latitude !== undefined || updateData.longitude !== undefined) {
      const latNum = toFiniteNumber(updateData.latitude);
      const lngNum = toFiniteNumber(updateData.longitude);
      const loc = buildLocation(latNum, lngNum);
      if (loc) updateData.location = loc;
    }
    const updated = await TechnicianProfile.findOneAndUpdate(
      { userId },
      updateData,
      { new: true, runValidators: true }
    ).select("-password");
    return updated || {};
  } else {
    const allowedFields = ["fname", "lname", "gender", "email"];
    const forbidden = new Set(["password", "status", "userId", "profileComplete"]);
    const updateData = {};
    Object.keys(body || {}).forEach((k) => {
      if (!forbidden.has(k) && allowedFields.includes(k)) updateData[k] = body[k];
    });

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

    return updated || {};
  }
};

/**
 * Admin list users by role with optimized aggregations.
 */
export const getAllUsersInternal = async ({ role, search }) => {
  if (!role) {
    const err = new Error("Role is required");
    err.statusCode = 400;
    throw err;
  }

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
    users = await User.aggregate([
      { $match: { role: "Customer", ...searchMatch } },
      {
        $lookup: {
          from: "servicebookings",
          localField: "_id",
          foreignField: "customerId",
          as: "serviceBookings",
        },
      },
      {
        $lookup: {
          from: "productbookings",
          localField: "_id",
          foreignField: "userId",
          as: "productBookings",
        },
      },
      {
        $lookup: {
          from: "addresses",
          localField: "_id",
          foreignField: "customerId",
          as: "customerAddresses",
        },
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
            profileComplete: { $ifNull: ["$profileComplete", false] },
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
                createdAt: "$$addr.createdAt",
              },
            },
          },
          jobStats: {
            service: {
              total: { $size: "$serviceBookings" },
              completed: {
                $size: {
                  $filter: {
                    input: "$serviceBookings",
                    as: "booking",
                    cond: { $eq: ["$$booking.status", "completed"] },
                  },
                },
              },
              cancelled: {
                $size: {
                  $filter: {
                    input: "$serviceBookings",
                    as: "booking",
                    cond: { $eq: ["$$booking.status", "cancelled"] },
                  },
                },
              },
            },
            product: {
              total: { $size: "$productBookings" },
            },
          },
        },
      },
      { $sort: { createdAt: -1 } },
    ]);
  } else if (role === "Technician") {
    users = await User.aggregate([
      { $match: { role: "Technician", ...searchMatch } },
      {
        $lookup: {
          from: "technicianprofiles",
          localField: "_id",
          foreignField: "userId",
          as: "techProfile",
        },
      },
      { $unwind: { path: "$techProfile", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "techniciankycs",
          localField: "techProfile._id",
          foreignField: "technicianId",
          as: "kycData",
        },
      },
      { $unwind: { path: "$kycData", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "servicebookings",
          localField: "techProfile._id",
          foreignField: "technicianId",
          as: "jobs",
        },
      },
      {
        $lookup: {
          from: "services",
          localField: "techProfile.skills.serviceId",
          foreignField: "_id",
          as: "skillsData",
        },
      },
      {
        $project: {
          _id: 1,
          mobileNumber: 1,
          email: 1,
          createdAt: 1,
          lastLoginAt: 1,
          technicianId: { $ifNull: ["$techProfile._id", null] },
          profile: {
            fname: {
              $cond: [
                { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ["$fname", ""] } } } }, 0] },
                "$fname",
                {
                  $cond: [
                    { $eq: [{ $type: "$kycData.bankDetails.accountHolderName" }, "string"] },
                    {
                      $let: {
                        vars: { name: { $ifNull: ["$kycData.bankDetails.accountHolderName", ""] } },
                        in: {
                          $cond: [
                            { $gt: [{ $strLenCP: { $trim: { input: "$$name" } } }, 0] },
                            { $arrayElemAt: [{ $split: ["$$name", " "] }, 0] },
                            "",
                          ],
                        },
                      },
                    },
                    "",
                  ],
                },
              ],
            },
            lname: {
              $cond: [
                { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ["$lname", ""] } } } }, 0] },
                "$lname",
                {
                  $cond: [
                    { $eq: [{ $type: "$kycData.bankDetails.accountHolderName" }, "string"] },
                    {
                      $let: {
                        vars: { name: { $ifNull: ["$kycData.bankDetails.accountHolderName", ""] } },
                        in: {
                          $cond: [
                            { $gt: [{ $strLenCP: { $trim: { input: "$$name" } } }, 0] },
                            { $arrayElemAt: [{ $split: ["$$name", " "] }, 1] },
                            "",
                          ],
                        },
                      },
                    },
                    "",
                  ],
                },
              ],
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
                                    cond: { $eq: ["$$svc._id", "$$skill.serviceId"] },
                                  },
                                },
                                0,
                              ],
                            },
                          },
                          in: { $ifNull: ["$$matchedService.name", ""] },
                        },
                      },
                    },
                  },
                },
                [],
              ],
            },
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
                  dlUrl: { $ifNull: ["$kycData.documents.dlUrl", null] },
                },
              },
              else: null,
            },
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
                bankUpdateRequired: { $ifNull: ["$kycData.bankUpdateRequired", false] },
              },
              else: null,
            },
          },
          training: {
            trainingCompleted: { $ifNull: ["$techProfile.trainingCompleted", false] },
            workStatus: { $ifNull: ["$techProfile.workStatus", "pending"] },
            approvedAt: { $ifNull: ["$techProfile.approvedAt", null] },
          },
          availability: {
            isOnline: { $ifNull: ["$techProfile.availability.isOnline", false] },
            lastSeen: { $ifNull: ["$techProfile.lastSeen", null] },
          },
          rating: {
            avg: { $ifNull: ["$techProfile.rating.avg", 0] },
            count: { $ifNull: ["$techProfile.rating.count", 0] },
          },
          jobStats: {
            accepted: {
              $size: {
                $filter: {
                  input: "$jobs",
                  as: "job",
                  cond: {
                    $in: ["$$job.status", ["accepted", "on_the_way", "reached", "in_progress", "completed"]],
                  },
                },
              },
            },
            completed: {
              $size: {
                $filter: {
                  input: "$jobs",
                  as: "job",
                  cond: { $eq: ["$$job.status", "completed"] },
                },
              },
            },
            cancelled: {
              $size: {
                $filter: {
                  input: "$jobs",
                  as: "job",
                  cond: { $eq: ["$$job.status", "cancelled"] },
                },
              },
            },
          },
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    await decryptAdminUserList(users);
  } else {
    users = await User.find({ role, ...searchMatch }).select("-password");
  }

  return users;
};

/**
 * Admin get user by ID.
 */
export const getUserByIdInternal = async ({ role, id }) => {
  if (!role || !id) {
    const err = new Error("Role and id are required");
    err.statusCode = 400;
    throw err;
  }

  const user = await User.findOne({ _id: id, role });
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  return user;
};
