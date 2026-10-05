/**
 * P3 — User repository (identity-owned persistence seam).
 *
 * Centralizes every User-collection operation used by authentication,
 * profile, account, provisioning, and auth-policy flows. Mongoose specifics
 * (model, selects, sessions, duplicate-key codes) stay in this file;
 * services express intent through application-oriented operations.
 *
 * Session support: pass `{ session }` in the options bag for transactional
 * callers. The service layer owns transaction boundaries (Task 11).
 */
import User from "../models/User.js";

const withSession = (options, query) =>
  options?.session ? query.session(options.session) : query;

export const findById = (userId, options = {}) =>
  withSession(options, User.findById(userId));

export const findByIdLean = (userId, select, options = {}) => {
  let query = User.findById(userId).lean();
  if (select) query = query.select(select);
  return withSession(options, query);
};

/** Per-request auth-subject read (status/role/tokenVersion only). */
export const findAuthSubjectById = (userId, options = {}) =>
  withSession(options, User.findById(userId).select("status role tokenVersion").lean());

/** Duplicate/lookup probe used by signup + provisioning (P2 oracle-safe selects). */
export const findDuplicateByIdentifier = (mobileNumber, options = {}) =>
  withSession(options, User.findOne({ mobileNumber }).select("_id status role"));

/** Frees a soft-deleted User's mobile/email so the number can be reused. */
export const anonymizeDeletedUser = (userId, options = {}) => {
  const timestamp = Date.now();
  return withSession(
    options,
    User.updateOne(
      { _id: userId },
      {
        $set: {
          mobileNumber: `deleted_${userId}_${timestamp}`,
          email: `deleted_${userId}_${timestamp}@example.invalid`,
        },
      }
    )
  );
};

export const findByMobile = (mobileNumber, options = {}) =>
  withSession(options, User.findOne({ mobileNumber }));

/** Login lookup: password hash explicitly selected (schema select:false). */
export const findLoginUserByMobile = (mobileNumber, options = {}) =>
  withSession(options, User.findOne({ mobileNumber }).select("+password role status tokenVersion"));

export const findByMobileAndRole = (mobileNumber, role, options = {}) =>
  withSession(options, User.findOne({ mobileNumber, role }));

export const findByRoleAndId = (role, id, options = {}) =>
  withSession(options, User.findOne({ _id: id, role }));

export const findUsersByRole = (role, searchMatch = {}, select = "-password", options = {}) =>
  withSession(options, User.find({ role, ...searchMatch }).select(select));

export const createUser = (doc, options = {}) =>
  options?.session ? User.create([doc], { session: options.session }) : User.create(doc);

export const updateLastLogin = (userId, options = {}) =>
  withSession(options, User.updateOne({ _id: userId }, { $set: { lastLoginAt: new Date() } }));

export const setUserPassword = (userId, passwordHash, options = {}) =>
  withSession(options, User.updateOne({ _id: userId }, { $set: { password: passwordHash } }));

/**
 * P5 — global session invalidation counter. Atomic $inc; returns the new
 * version. Pre-P5 docs without the field start from the schema default
 * (0) — $inc on a missing path treats it as 0, so no backfill is needed.
 */
export const bumpTokenVersion = async (userId, options = {}) => {
  const res = await withSession(
    options,
    User.findByIdAndUpdate(
      userId,
      { $inc: { tokenVersion: 1 } },
      { new: true, projection: { tokenVersion: 1 } }
    )
  );
  return res?.tokenVersion ?? null;
};

export const updateUserById = (userId, update, mongoOptions = {}, options = {}) => {
  let query = User.findByIdAndUpdate(userId, update, mongoOptions);
  if (options?.select) query = query.select(options.select);
  return withSession(options, query);
};

export const countActiveOwnersExcluding = (userId, options = {}) =>
  withSession(
    options,
    User.countDocuments({ role: "Owner", status: "Active", _id: { $ne: userId } })
  );

export const deleteUserById = (userId, options = {}) =>
  withSession(options, User.deleteOne({ _id: userId }));

export const deleteManyByCustomerId = (filter, options = {}) =>
  withSession(options, User.deleteMany(filter));

/** Debug lookup (Owner/Admin tooling): account + role linkage, never credentials. */
export const findDebugSubjectByIdentifier = (mobileNumber, options = {}) =>
  withSession(
    options,
    User.findOne({ mobileNumber }).select("_id role fname lname mobileNumber email status createdAt")
  );

/** Legacy FCM mirror writes (dual-write compat; removal is P7). */
export const addFcmMirror = (userId, fcmToken) =>
  User.updateOne({ _id: userId }, { $addToSet: { fcmTokens: fcmToken } }).catch(() => {});

export const pullFcmMirror = (userId, pull) =>
  User.updateOne({ _id: userId }, { $pull: pull }).catch(() => {});

/**
 * Admin directory aggregations (moved verbatim from profileService —
 * P3 seam only; shapes, sorts, and lookups unchanged).
 */
const customerDirectoryStages = (searchMatch) => [
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
    ];

const technicianDirectoryStages = (searchMatch) => [
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
    ];

export const aggregateCustomerDirectory = (searchMatch = {}) =>
  User.aggregate(customerDirectoryStages(searchMatch));

export const aggregateTechnicianDirectory = (searchMatch = {}) =>
  User.aggregate(technicianDirectoryStages(searchMatch));
