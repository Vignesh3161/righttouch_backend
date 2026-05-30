import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import User from "../Schemas/User.js";
import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import { broadcastPendingJobsToTechnician } from "../Utils/technicianMatching.js";
import { handleLocationUpdate } from "../Utils/technicianLocation.js";

// ================= UPDATE TECHNICIAN LIVE LOCATION ================= //sk
export const updateTechnicianLocation = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    const { latitude, longitude } = req.body;

    if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ success: false, message: "Invalid coordinates", result: {} });
    }

    const result = await handleLocationUpdate(technicianProfileId, latitude, longitude, req.io);

    return res.json({
      success: true,
      message: result.matchCalculation ? "Location updated and jobs calculated" : "Location updated (matching rate limited)",
      result
    });
  } catch (error) {
    console.error("updateTechnicianLocation Error:", error);
    return res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

const isValidObjectId = mongoose.Types.ObjectId.isValid;
const TECHNICIAN_STATUSES = ["pending", "trained", "approved", "suspended", "deleted"];

const validateSkills = (skills) => {
  if (skills === undefined) return true;
  if (!Array.isArray(skills)) return false;
  return skills.every((item) =>
    item && item.serviceId && isValidObjectId(item.serviceId)
  );
};

const normalizeServiceIdsInput = (body) => {
  const raw = body?.serviceIds ?? body?.serviceId;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const normalized = list
    .map((v) => (typeof v === "string" ? v.trim() : v))
    .filter(Boolean)
    .map(String);

  // de-dupe
  return Array.from(new Set(normalized));
};

/* ================= HELPER: ENRICH TECHNICIAN WITH ACTIVATION STATUS ================= */
const enrichTechnicianWithActivationStatus = async (technicianDoc) => {
  try {
    if (!technicianDoc) return null;

    const techObj = technicianDoc.toObject ? technicianDoc.toObject() : technicianDoc;

    // Check KYC approval
    const kyc = await TechnicianKyc.findOne({
      technicianId: technicianDoc._id,
    }).select("verificationStatus bankVerified");

    const isKycApproved = kyc && kyc.verificationStatus === "approved";
    const isBankVerified = kyc && kyc.bankVerified === true;
    const isTrainingCompleted = technicianDoc.trainingCompleted === true;

    // Active = KYC + Bank + Training all approved
    techObj.isActiveTechnician = isKycApproved && isBankVerified && isTrainingCompleted;

    return techObj;
  } catch (error) {
    console.error("enrichTechnicianWithActivationStatus error:", error);
    return technicianDoc;
  }
};

/* ================= HELPER: ENFORCE ONLINE PREREQUISITE INTEGRITY ================= */
const enforceOnlinePrerequisites = async (technicianDoc) => {
  try {
    if (!technicianDoc) return null;

    const techObj = technicianDoc.toObject ? technicianDoc.toObject() : technicianDoc;

    // Online status is only valid if ALL prerequisites are met
    const canBeOnline =
      techObj.trainingCompleted === true &&
      techObj.workStatus === "approved";

    // Also check KYC approval
    if (canBeOnline) {
      const kyc = await TechnicianKyc.findOne({
        technicianId: technicianDoc._id || technicianDoc.technicianId,
      }).select("verificationStatus");

      if (!kyc || kyc.verificationStatus !== "approved") {
        techObj.availability = techObj.availability || {};
        techObj.availability.isOnline = false;
        console.warn(
          `⚠️ Enforced offline for technician ${technicianDoc._id}: KYC not approved`
        );
      }
    } else {
      // Force offline if prerequisites not met
      techObj.availability = techObj.availability || {};
      techObj.availability.isOnline = false;
    }

    return techObj;
  } catch (error) {
    console.error("enforceOnlinePrerequisites error:", error);
    return technicianDoc;
  }
};

/* ================= ADD TECHNICIAN SKILLS (APPEND) ================= */
export const addTechnicianSkills = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const serviceIds = normalizeServiceIdsInput(req.body);
    if (serviceIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "serviceIds (or serviceId) is required",
        result: {},
      });
    }

    const invalidIds = serviceIds.filter((id) => !isValidObjectId(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid serviceIds",
        result: { invalidIds },
      });
    }

    const serviceObjectIds = serviceIds.map((id) => new mongoose.Types.ObjectId(id));

    // Optional safety: ensure services exist & active
    const activeServices = await Service.find({ _id: { $in: serviceObjectIds }, isActive: true })
      .select("_id")
      .lean();
    const activeSet = new Set(activeServices.map((s) => String(s._id)));
    const missingOrInactive = serviceIds.filter((id) => !activeSet.has(String(id)));
    if (missingOrInactive.length > 0) {
      return res.status(404).json({
        success: false,
        message: "Some services were not found or inactive",
        result: { missingOrInactive },
      });
    }

    const technician = await TechnicianProfile.findByIdAndUpdate(
      technicianProfileId,
      {
        $addToSet: {
          skills: { $each: serviceObjectIds.map((sid) => ({ serviceId: sid })) },
        },
      },
      { new: true, runValidators: true }
    )
      .populate("skills.serviceId", "serviceName")
      .select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Skills added successfully",
      result: technician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= REMOVE TECHNICIAN SKILLS ================= */
export const removeTechnicianSkills = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const serviceIds = normalizeServiceIdsInput(req.body);
    if (serviceIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "serviceIds (or serviceId) is required",
        result: {},
      });
    }

    const invalidIds = serviceIds.filter((id) => !isValidObjectId(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid serviceIds",
        result: { invalidIds },
      });
    }

    const serviceObjectIds = serviceIds.map((id) => new mongoose.Types.ObjectId(id));

    const technician = await TechnicianProfile.findByIdAndUpdate(
      technicianProfileId,
      {
        $pull: {
          skills: { serviceId: { $in: serviceObjectIds } },
        },
      },
      { new: true, runValidators: true }
    )
      .populate("skills.serviceId", "serviceName")
      .select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Skills removed successfully",
      result: technician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPDATE TECHNICIAN SKILLS ================= */
export const createTechnician = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    const {
      skills,
      fname,
      lname,
      gender,
      address,
      city,
      email,
      state,
      pincode,
      locality,
      experienceYears,
      specialization,
      profileComplete,
    } = req.body;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    if (!validateSkills(skills)) {
      return res.status(400).json({
        success: false,
        message: "Invalid skills format",
        result: {},
      });
    }

    // Ensure only users with Technician role can update skills
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Only users with Technician role can update skills",
        result: {},
      });
    }

    const profileUpdate = {};
    if (skills !== undefined) profileUpdate.skills = skills;
    if (address !== undefined) profileUpdate.address = address;
    if (city !== undefined) profileUpdate.city = city;
    if (state !== undefined) profileUpdate.state = state;
    if (pincode !== undefined) profileUpdate.pincode = pincode;
    if (locality !== undefined) profileUpdate.locality = locality;
    if (experienceYears !== undefined) profileUpdate.experienceYears = experienceYears;
    if (specialization !== undefined) profileUpdate.specialization = specialization;
    if (profileComplete !== undefined) profileUpdate.profileComplete = profileComplete;

    const userUpdate = {};
    const u = req.body.user || {};

    const finalFname = fname !== undefined ? fname : u.fname;
    const finalLname = lname !== undefined ? lname : u.lname;
    const finalGender = gender !== undefined ? gender : u.gender;
    const finalProfileComplete = profileComplete !== undefined ? profileComplete : u.profileComplete;

    let existingUser = null;
    if (finalFname === undefined || finalLname === undefined) {
      existingUser = await mongoose
        .model("User")
        .findById(req.user?.userId)
        .select("fname lname")
        .lean();
    }

    const effectiveFname = finalFname !== undefined ? finalFname : existingUser?.fname;
    const effectiveLname = finalLname !== undefined ? finalLname : existingUser?.lname;
    const hasCompleteName =
      typeof effectiveFname === "string" &&
      effectiveFname.trim().length > 0 &&
      typeof effectiveLname === "string" &&
      effectiveLname.trim().length > 0;

    if (hasCompleteName) profileUpdate.profileComplete = true;

    if (finalFname !== undefined) userUpdate.fname = finalFname;
    if (finalLname !== undefined) userUpdate.lname = finalLname;
    if (finalGender !== undefined) userUpdate.gender = finalGender;
    if (finalProfileComplete !== undefined) userUpdate.profileComplete = finalProfileComplete;

    if (Object.keys(userUpdate).length > 0) {
      await mongoose.model("User").findByIdAndUpdate(req.user?.userId, userUpdate, {
        new: true,
        runValidators: true,
      });
    }

    const technician = await TechnicianProfile.findByIdAndUpdate(
      technicianProfileId,
      profileUpdate,
      { new: true, runValidators: true }
    ).select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Skills updated successfully",
      result: technician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET ALL TECHNICIANS ================= */
export const getAllTechnicians = async (req, res) => {
  try {
    const { workStatus, search } = req.query;
    const profileQuery = {};
    // Always exclude deleted technicians
    const query = { workStatus: { $ne: "deleted" } };

    if (workStatus) {
      if (!TECHNICIAN_STATUSES.includes(workStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid workStatus filter",
          result: {},
        });
      }
      profileQuery.workStatus = workStatus;
      query.workStatus = workStatus;  // Overrides the $ne clause
    }

    // 🔍 Two-step search: mobile/name lives on User, not TechnicianProfile
    if (search && search.trim().length >= 2) {
      const searchRegex = { $regex: search.trim(), $options: "i" };

      // Step 1: Find matching User IDs (name OR mobile number)
      const matchingUsers = await mongoose.model("User").find({
        $or: [
          { fname: searchRegex },
          { lname: searchRegex },
          { mobileNumber: searchRegex },
          { email: searchRegex },
        ],
      }).select("_id").lean();

      const matchingUserIds = matchingUsers.map((u) => u._id);

      // Step 2: Also search profile-level fields (locality, specialization)
      profileQuery.$or = [
        { userId: { $in: matchingUserIds } },
        { locality: searchRegex },
        { specialization: searchRegex },
      ];
    }

    const technicians = await TechnicianProfile.find(profileQuery)
      .populate("skills.serviceId", "serviceName")
      .populate({
        path: "userId",
        select: "fname lname gender mobileNumber email lastLoginAt",
      })
      .select("-password")
      .sort({ createdAt: -1 });

    // Enrich each technician with activation status AND enforce online prerequisites
    const enrichedTechnicians = await Promise.all(
      technicians.map(async (tech) => {
        const enriched = await enrichTechnicianWithActivationStatus(tech);
        const enforced = await enforceOnlinePrerequisites(enriched);
        return enforced;
      })
    );

    return res.status(200).json({
      success: true,
      message: "Technicians fetched successfully",
      result: enrichedTechnicians,
    });
  } catch (error) {
    console.error("getAllTechnicians Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET TECHNICIAN BY ID ================= */
export const getTechnicianById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(id)
      .populate("skills.serviceId", "serviceName")
      .populate({
        path: "userId",
        select: "fname lname gender mobileNumber email lastLoginAt",
      })
      .select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    // Enrich with activation status AND enforce online prerequisites
    const enrichedTechnician = await enrichTechnicianWithActivationStatus(technician);
    const enforcedTechnician = await enforceOnlinePrerequisites(enrichedTechnician);

    return res.status(200).json({
      success: true,
      message: "Technician fetched successfully",
      result: enforcedTechnician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET MY TECHNICIAN (FROM TOKEN) ================= */
export const getMyTechnician = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(technicianProfileId)
      .populate("skills.serviceId", "serviceName")
      .populate({
        path: "userId",
        select: "fname lname gender mobileNumber email role status profileComplete termsAndServices privacyPolicy termsAndServicesAt privacyPolicyAt createdAt updatedAt lastLoginAt",
      })
      .select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    // Enrich with activation status AND enforce online prerequisites
    const enrichedTechnician = await enrichTechnicianWithActivationStatus(technician);
    const enforcedTechnician = await enforceOnlinePrerequisites(enrichedTechnician);

    return res.status(200).json({
      success: true,
      message: "Technician fetched successfully",
      result: enforcedTechnician,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPDATE TECHNICIAN ================= */
export const updateTechnician = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {
      user: userData,
      skills,
      availability,
      locality,
      address,
      city,
      state,
      pincode,
      experienceYears,
      specialization,
      profileComplete
    } = req.body;

    const technicianProfileId = req.user?.technicianProfileId;
    const userId = req.user?.userId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    if (skills !== undefined && !validateSkills(skills)) {
      return res.status(400).json({ success: false, message: "Invalid skills format", result: {} });
    }

    let technician = await TechnicianProfile.findById(technicianProfileId);
    if (!technician) {
      return res.status(404).json({ success: false, message: "Technician not found", result: {} });
    }

    await session.withTransaction(async () => {
      // 1. Update TechnicianProfile fields
      if (locality !== undefined) technician.locality = locality;
      if (address !== undefined) technician.address = address;
      if (city !== undefined) technician.city = city;
      if (state !== undefined) technician.state = state;
      if (pincode !== undefined) technician.pincode = pincode;
      if (experienceYears !== undefined) technician.experienceYears = experienceYears;
      if (specialization !== undefined) technician.specialization = specialization;
      if (skills !== undefined) technician.skills = skills;

      // 2. Handle Online Status & Verification Logic
      // If trainingCompleted is being updated to false, force offline
      if (userData?.trainingCompleted === false || req.body.trainingCompleted === false) {
        technician.availability.isOnline = false;
      }

      if (availability?.isOnline !== undefined) {
        if (availability.isOnline) {
          const pendingRequirements = [];

          if (!technician.trainingCompleted) {
            pendingRequirements.push("trainingCompleted = true");
          }

          if (technician.workStatus !== "approved") {
            pendingRequirements.push("workStatus = approved");
          }

          const kyc = await mongoose
            .model("TechnicianKyc")
            .findOne({ technicianId: technicianProfileId })
            .select("verificationStatus");

          if (!kyc || kyc.verificationStatus !== "approved") {
            pendingRequirements.push("KYC verificationStatus = approved");
          }

          if (pendingRequirements.length > 0) {
            throw new Error(
              `Cannot set online true. First complete: ${pendingRequirements.join(", ")}`
            );
          }
        }
        technician.availability.isOnline = Boolean(availability.isOnline);
      }

      // 3. Update User fields (Handle both flat and nested user object)
      const u = userData || {};
      const userUpdate = {};
      let userUpdated = false;

      const finalFname = u.fname !== undefined ? u.fname : req.body.fname;
      const finalLname = u.lname !== undefined ? u.lname : req.body.lname;
      const finalEmail = u.email !== undefined ? u.email : req.body.email;
      const finalGender = u.gender !== undefined ? u.gender : req.body.gender;

      if (finalFname !== undefined) { userUpdate.fname = finalFname; userUpdated = true; }
      if (finalLname !== undefined) { userUpdate.lname = finalLname; userUpdated = true; }
      if (finalEmail !== undefined) { userUpdate.email = finalEmail; userUpdated = true; }
      if (finalGender !== undefined) { userUpdate.gender = finalGender; userUpdated = true; }

      if (profileComplete !== undefined || u.profileComplete !== undefined || req.body.profileComplete !== undefined) {
        userUpdate.profileComplete = profileComplete !== undefined ? profileComplete
          : (u.profileComplete !== undefined ? u.profileComplete : req.body.profileComplete);
        userUpdated = true;
      }

      // phone number updates are ignored as per requirement

      if (userUpdated) {
        await mongoose.model("User").findByIdAndUpdate(userId, userUpdate, { session, runValidators: true });
      }

      // 4. Calculate Profile Completion
      const isComplete = Boolean(
        technician.address &&
        technician.city &&
        technician.specialization &&
        technician.locality &&
        technician.skills?.length > 0
      );
      technician.profileComplete = profileComplete !== undefined ? profileComplete : isComplete;

      await technician.save({ session });
    });

    // 5. Proactive Broadcast if technician went online
    if (availability?.isOnline === true) {
      broadcastPendingJobsToTechnician(technicianProfileId, req.io).catch(err =>
        console.error("Proactive broadcast error:", err)
      );
    }

    const updatedProfile = await TechnicianProfile.findById(technicianProfileId)
      .populate({
        path: "userId",
        select: "fname lname gender mobileNumber email",
      })
      .populate("skills.serviceId", "serviceName")
      .select("-password");

    return res.status(200).json({
      success: true,
      message: "Technician profile updated successfully",
      result: updatedProfile,
    });

  } catch (error) {
    if (res.headersSent) return;
    console.error("Update technician error:", error);
    return res.status(400).json({
      success: false,
      message: error.message,
      result: { error: error.message }
    });
  } finally {
    session.endSession();
  }
};

/* ================= UPDATE TECHNICIAN STATUS (ADMIN) ================= */
export const updateTechnicianStatus = async (req, res) => {
  try {
    const { technicianId, trainingCompleted, workStatus } = req.body;

    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    if (req.user?.role !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Owner access only",
      });
    }

    const technician = await TechnicianProfile.findById(technicianId);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    if (trainingCompleted !== undefined) {
      technician.trainingCompleted = Boolean(trainingCompleted);
      if (trainingCompleted === true) {
        technician.workStatus = "trained";
      }
    }

    if (workStatus !== undefined) {
      if (!TECHNICIAN_STATUSES.includes(workStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid workStatus value. Must be: pending, trained, approved, or suspended",
          result: {},
        });
      }

      technician.workStatus = workStatus;

      if (workStatus === "suspended") {
        technician.availability.isOnline = false;
      }
    }

    await technician.save();

    const result = technician.toObject();
    delete result.password;

    return res.status(200).json({
      success: true,
      message: "Technician status updated successfully",
      result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE TECHNICIAN ================= */
export const deleteTechnician = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(id).session(session);
    if (!technician) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    const isOwner = req.user?.role === "Owner";
    if (!isOwner && (!technicianProfileId || technician._id.toString() !== technicianProfileId.toString())) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: "Access denied",
        result: {},
      });
    }

    // 1. Fetch technician user data for snapshot
    const techUser = await User.findById(technician.userId)
      .select("fname lname mobileNumber email")
      .session(session);

    // 2. Update all ServiceBookings with technician snapshot before deletion
    await ServiceBooking.updateMany(
      { technicianId: technician._id },
      {
        $set: {
          "technicianSnapshot.name": `${techUser?.fname || ""} ${techUser?.lname || ""}`.trim() || "Unknown",
          "technicianSnapshot.mobile": techUser?.mobileNumber || "",
          "technicianSnapshot.deleted": true,
        },
      },
      { session }
    );

    // 3. Delete TechnicianKyc
    await TechnicianKyc.deleteOne(
      { technicianId: technician._id }
    ).session(session);

    // 4. Soft Delete / Anonymize User (Critical for re-registration)
    const userId = technician.userId;
    const timestamp = Date.now();
    const anonymizedId = `deleted_${userId}_${timestamp}`;

    await User.findByIdAndUpdate(
      userId,
      {
        status: "Deleted",
        mobileNumber: anonymizedId,
        email: techUser?.email ? `${anonymizedId}@example.invalid` : undefined,
        password: null,
        lastLoginAt: null,
        profileComplete: false,
        fname: null,
        lname: null
      },
      { session }
    );

    // 5. Hard delete TechnicianProfile (Clean up)
    await technician.deleteOne({ session });

    await session.commitTransaction();
    console.log(`🗑️ Deleted technician ${id} (Profile: Hard, User: Soft/Anonymized)`);

    return res.status(200).json({
      success: true,
      message: "Technician deleted successfully",
      result: {},
    });

  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("deleteTechnician Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  } finally {
    session.endSession();
  }
};

/* ================= UPDATE TECHNICIAN TRAINING STATUS (OWNER ONLY) ================= */
export const updateTechnicianTraining = async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { trainingCompleted } = req.body;

    // 🛡️ Owner access only
    if (req.user?.role !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Owner access only",
        result: {},
      });
    }

    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    if (typeof trainingCompleted !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "trainingCompleted must be a boolean value",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(technicianId).select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    // Update training status
    technician.trainingCompleted = trainingCompleted;

    // If training is being set to false, force offline
    if (!trainingCompleted && technician.availability?.isOnline) {
      technician.availability.isOnline = false;
      console.log(`⚠️ Technician ${technicianId} forced offline due to incomplete training`);
    }

    await technician.save();

    return res.status(200).json({
      success: true,
      message: `Training status updated to ${trainingCompleted ? 'completed' : 'incomplete'}`,
      result: {
        technicianId: technician._id,
        trainingCompleted: technician.trainingCompleted,
        workStatus: technician.workStatus,
        isOnline: technician.availability?.isOnline || false,
      },
    });
  } catch (error) {
    console.error("Update training error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};
/* ================= UPLOAD TECHNICIAN PROFILE IMAGE ================= */
export const uploadProfileImage = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Only technicians can upload profile image",
        result: {},
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image file provided",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findByIdAndUpdate(
      technicianProfileId,
      { profileImage: req.file.path },
      { new: true, runValidators: true }
    ).select("-password");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile image uploaded successfully",
      result: {
        profileImage: technician.profileImage,
      },
    });
  } catch (error) {
    console.error("Upload profile image error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};
