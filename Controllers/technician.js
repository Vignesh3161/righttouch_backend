import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import User from "../Schemas/User.js";
import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import { broadcastPendingJobsToTechnician } from "../Utils/technicianMatching.js";
import { handleLocationUpdate } from "../Utils/technicianLocation.js";
import { revokeSocketSession } from "../Utils/socketSessionControl.js";
import {
  resolveZoneFromCoordinates,
  resolveDistrictAndZoneFromCoordinates,
} from "../Utils/resolveZoneFromCoordinates.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import CityZone from "../Schemas/CityZone.js";
import TechnicianSkillRequest from "../Schemas/TechnicianSkillRequest.js";
import { getDekForKycDoc, decryptBankDetails } from "../Utils/kycFieldCrypto.js";

import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";

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

    const result = await handleLocationUpdate(technicianProfileId, latitude, longitude, req.io, "http");

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

const MAX_FCM_TOKENS = 5;

// ================= REGISTER / UNREGISTER FCM PUSH TOKEN =================
// Called by the app on login/foreground. `unregister: true` removes the token
// (logout / device removed). Keeps a small per-device cap; tokens are also
// pruned automatically when FCM reports device-not-registered on send.
export const registerTechnicianFcmToken = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    const { token, unregister } = req.body || {};

    if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }
    if (!token || typeof token !== "string" || token.length < 10 || token.length > 4096) {
      return res.status(400).json({ success: false, message: "Invalid FCM token", result: {} });
    }

    if (unregister) {
      await TechnicianProfile.updateOne(
        { _id: technicianProfileId },
        { $pull: { fcmTokens: token } }
      );
      console.log(`📴 FCM token unregistered for tech ${technicianProfileId}`);
    } else {
      // Register with dedupe + cap: keep newest MAX_FCM_TOKENS tokens.
      const profile = await TechnicianProfile.findById(technicianProfileId)
        .select("fcmTokens")
        .lean();
      let tokens = (profile?.fcmTokens || []).filter((t) => t !== token);
      tokens.push(token);
      if (tokens.length > MAX_FCM_TOKENS) tokens = tokens.slice(-MAX_FCM_TOKENS);

      await TechnicianProfile.updateOne(
        { _id: technicianProfileId },
        { $set: { fcmTokens: tokens } }
      );
      console.log(`📱 FCM token registered for tech ${technicianProfileId} (${tokens.length}/${MAX_FCM_TOKENS})`);
    }

    return res.json({ success: true, message: "FCM token updated" });
  } catch (error) {
    console.error("registerTechnicianFcmToken Error:", error);
    return res.status(500).json({ success: false, message: error.message, result: {} });
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

/* ================= HELPER: ENRICH TECHNICIAN WITH ACTIVATION STATUS & BANK DETAILS ================= */
const enrichTechnicianWithActivationStatus = async (technicianDoc) => {
  try {
    if (!technicianDoc) return null;

    const techObj = technicianDoc.toObject ? technicianDoc.toObject() : technicianDoc;

    // Check KYC approval & bank details
    const kyc = await TechnicianKyc.findOne({
      technicianId: technicianDoc._id,
    });

    const isKycApproved = kyc && kyc.verificationStatus === "approved";
    const isBankVerified = kyc && (kyc.bankVerified === true || kyc.bankVerificationStatus === "approved");
    const isTrainingCompleted = technicianDoc.trainingCompleted === true;

    // Decrypt & populate bank details on technician object if present on KYC
    if (kyc && kyc.bankDetails) {
      try {
        const dek = await getDekForKycDoc(kyc);
        const plainBank = decryptBankDetails(kyc.bankDetails, dek) || {};
        techObj.bankDetails = {
          accountHolderName: plainBank.accountHolderName || techObj.bankDetails?.accountName || techObj.bankDetails?.accountHolderName || null,
          accountNumber: plainBank.accountNumber || techObj.bankDetails?.accountNumber || null,
          bankName: plainBank.bankName || techObj.bankDetails?.bankName || null,
          branchName: plainBank.branchName || techObj.bankDetails?.branchName || null,
          ifscCode: plainBank.ifscCode || techObj.bankDetails?.ifscCode || null,
          upiId: plainBank.upiId || techObj.bankDetails?.upiId || null,
        };
        techObj.isBankVerified = isBankVerified;
        techObj.bankVerified = isBankVerified;
      } catch (decErr) {
        console.error("Error decrypting bank details for tech:", technicianDoc._id, decErr.message);
      }
    }

    // Active = KYC + Training approved (Bank verification is for payouts)
    techObj.isActiveTechnician = isKycApproved && isTrainingCompleted;

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

    const { experienceYears } = req.body;
    if (experienceYears !== undefined && experienceYears > 15) {
      return res.status(400).json({
        success: false,
        message: "Experience cannot exceed 15 years",
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

    const technician = await TechnicianProfile.findById(technicianProfileId).select("-password");
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    // 🏘 ZONE-SERVICE CHECK — technician can only add skills for services approved in their zone
    if (technician.cityZoneId) {
      const approvedMappings = await ZoneServiceMapping.find({
        zoneId: technician.cityZoneId,
        serviceId: { $in: serviceObjectIds },
        active: true,
      })
        .select("serviceId")
        .lean();

      const approvedServiceIds = new Set(
        approvedMappings.map((m) => String(m.serviceId))
      );

      const blockedIds = serviceObjectIds.filter(
        (sid) => !approvedServiceIds.has(String(sid))
      );

      if (blockedIds.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Some services are not available in your zone",
          result: { blockedServiceIds: blockedIds.map(String) },
        });
      }
    }

    // Filter out serviceIds that the technician already has
    const existingServiceIds = technician.skills.map((skill) => String(skill.serviceId));
    const newServiceObjectIds = serviceObjectIds.filter((sid) => !existingServiceIds.includes(String(sid)));

    if (newServiceObjectIds.length > 0) {
      const exp = experienceYears !== undefined ? Number(experienceYears) : 0;
      const newSkills = newServiceObjectIds.map((sid) => ({ serviceId: sid, experienceYears: exp }));
      technician.skills.push(...newSkills);
      await technician.save();
    }

    // Populate skills for the response
    await technician.populate("skills.serviceId", "serviceName");

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

/* ==========================================================================
   🏙 STEP 1: GET DISTRICTS FOR TECHNICIAN REGISTRATION
   Returns ONLY active districts where technician registration is enabled.
   ========================================================================== */
export const getRegistrationDistricts = async (req, res) => {
  try {
    const districts = await OperationalCity.find({
      active: true,
      isRegistrationEnabled: true,
    })
      .select("_id name city state code polygon active isRegistrationEnabled isJobEnabled")
      .sort({ name: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Registration-enabled districts fetched successfully",
      result: districts,
    });
  } catch (error) {
    console.error("getRegistrationDistricts Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching registration districts",
      result: { error: error.message },
    });
  }
};

/* ==========================================================================
   🏘 STEP 2: GET CITY / ZONES FOR SELECTED DISTRICT
   Returns active micro-zones belonging to the selected active district.
   ========================================================================== */
export const getRegistrationZones = async (req, res) => {
  try {
    const districtId = req.query.districtId || req.query.operationalCityId || req.query.cityId;

    if (!districtId || !isValidObjectId(districtId)) {
      return res.status(400).json({
        success: false,
        message: "Valid districtId is required",
        result: {},
      });
    }

    // Verify district exists and is open for registration
    const district = await OperationalCity.findOne({
      _id: districtId,
      active: true,
      isRegistrationEnabled: true,
    }).lean();

    if (!district) {
      return res.status(404).json({
        success: false,
        message: "District not found or technician registration is disabled for this district",
        result: {},
      });
    }

    const zones = await CityZone.find({
      operationalCityId: districtId,
      active: true,
    })
      .select("_id name zoneCode description polygon active operationalCityId")
      .sort({ name: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Active zones fetched successfully",
      result: {
        district: {
          _id: district._id,
          name: district.name,
          code: district.code,
        },
        zones,
      },
    });
  } catch (error) {
    console.error("getRegistrationZones Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching registration zones",
      result: { error: error.message },
    });
  }
};

/* ==========================================================================
   📍 STEP 3 & 4: AUTHORITATIVE GPS & ZONE MISMATCH VALIDATION
   Authoritative check: validates GPS coordinates against selected District & Zone.
   Prevents registering in incorrect zone.
   ========================================================================== */
export const validateRegistrationLocation = async (req, res) => {
  try {
    const { latitude, longitude, selectedDistrictId, selectedZoneId } = req.body;

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_COORDINATES",
        message: "Valid latitude and longitude are required",
        result: {},
      });
    }

    const { district: resolvedDistrict, zone: resolvedZone } =
      await resolveDistrictAndZoneFromCoordinates(lat, lng);

    if (!resolvedDistrict) {
      return res.status(400).json({
        success: false,
        code: "LOCATION_OUTSIDE_SERVICE_AREA",
        message: "Your current GPS location is outside our operational service areas.",
        result: {
          providedCoordinates: { latitude: lat, longitude: lng },
        },
      });
    }

    if (!resolvedDistrict.isRegistrationEnabled) {
      return res.status(400).json({
        success: false,
        code: "REGISTRATION_DISABLED_IN_DISTRICT",
        message: `Technician registration is currently disabled in ${resolvedDistrict.name}.`,
        result: {
          resolvedDistrict: {
            id: resolvedDistrict._id,
            name: resolvedDistrict.name,
          },
        },
      });
    }

    // Check District Match if selectedDistrictId provided
    if (selectedDistrictId && isValidObjectId(selectedDistrictId)) {
      if (resolvedDistrict._id.toString() !== selectedDistrictId.toString()) {
        const selectedDistDoc = await OperationalCity.findById(selectedDistrictId).select("name").lean();
        const selectedName = selectedDistDoc?.name || "the selected district";
        return res.status(400).json({
          success: false,
          code: "LOCATION_DISTRICT_MISMATCH",
          message: `Your GPS location is in ${resolvedDistrict.name}, but you selected ${selectedName}. Please select the correct district.`,
          result: {
            resolvedDistrict: {
              id: resolvedDistrict._id,
              name: resolvedDistrict.name,
              code: resolvedDistrict.code,
            },
            selectedDistrictId,
          },
        });
      }
    }

    // Check Zone Match if selectedZoneId provided
    if (selectedZoneId && isValidObjectId(selectedZoneId)) {
      if (!resolvedZone) {
        return res.status(400).json({
          success: false,
          code: "LOCATION_ZONE_MISMATCH",
          message: "Your GPS location does not fall into any active micro-zone within this district. Please check your address.",
          result: {
            resolvedDistrict: {
              id: resolvedDistrict._id,
              name: resolvedDistrict.name,
            },
          },
        });
      }

      if (resolvedZone._id.toString() !== selectedZoneId.toString()) {
        const selectedZoneDoc = await CityZone.findById(selectedZoneId).select("name").lean();
        const selectedZoneName = selectedZoneDoc?.name || "the selected area";
        return res.status(400).json({
          success: false,
          code: "LOCATION_ZONE_MISMATCH",
          message: `Your address is located in ${resolvedZone.name}, but you selected ${selectedZoneName}. Please select the correct service area.`,
          result: {
            resolvedZone: {
              id: resolvedZone._id,
              name: resolvedZone.name,
              zoneCode: resolvedZone.zoneCode,
            },
            resolvedDistrict: {
              id: resolvedDistrict._id,
              name: resolvedDistrict.name,
            },
            selectedZoneId,
          },
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Location validation successful",
      result: {
        valid: true,
        resolvedDistrict: {
          _id: resolvedDistrict._id,
          name: resolvedDistrict.name,
          code: resolvedDistrict.code,
        },
        resolvedZone: resolvedZone ? {
          _id: resolvedZone._id,
          name: resolvedZone.name,
          zoneCode: resolvedZone.zoneCode,
        } : null,
      },
    });
  } catch (error) {
    console.error("validateRegistrationLocation Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error validating registration location",
      result: { error: error.message },
    });
  }
};

/* ==========================================================================
   🛠 STEP 5: GET SERVICES AVAILABLE IN ZONE (FROM ZoneServiceMapping)
   Returns active services configured for the zone, annotated with availability
   and technician's skill approval statuses.
   ========================================================================== */
export const getZoneServicesForTechnician = async (req, res) => {
  try {
    let zoneId = req.query.zoneId || req.query.cityZoneId;

    // If authenticated technician and zoneId not passed in query, use registered zone
    if (!zoneId && req.user?.technicianProfileId) {
      const tech = await TechnicianProfile.findById(req.user.technicianProfileId).select("cityZoneId").lean();
      zoneId = tech?.cityZoneId;
    }

    if (!zoneId || !isValidObjectId(zoneId)) {
      return res.status(400).json({
        success: false,
        message: "Valid zoneId is required",
        result: {},
      });
    }

    const zone = await CityZone.findById(zoneId)
      .populate("operationalCityId", "name code")
      .lean();

    if (!zone) {
      return res.status(404).json({
        success: false,
        message: "Zone not found",
        result: {},
      });
    }

    // Fetch active ZoneServiceMapping for this zone
    const mappings = await ZoneServiceMapping.find({
      zoneId,
      active: true,
    })
      .populate("serviceId", "serviceName image description category price isActive")
      .lean();

    const activeMappedServiceMap = new Map();
    for (const m of mappings) {
      if (m.serviceId && m.serviceId.isActive) {
        activeMappedServiceMap.set(String(m.serviceId._id), m);
      }
    }

    // Fetch all active services in system catalog to show unavailable/requestable services
    const allServices = await Service.find({ isActive: true })
      .select("serviceName image description category price")
      .sort({ serviceName: 1 })
      .lean();

    // If technician is authenticated, fetch their current skills and pending skill requests
    let techSkillSet = new Set();
    let pendingRequestMap = new Map();

    if (req.user?.technicianProfileId) {
      const techProfile = await TechnicianProfile.findById(req.user.technicianProfileId)
        .select("skills")
        .lean();
      if (techProfile?.skills) {
        techSkillSet = new Set(techProfile.skills.map((s) => String(s.serviceId)));
      }

      const pendingRequests = await TechnicianSkillRequest.find({
        technicianId: req.user.technicianProfileId,
        status: { $in: ["pending", "rejected"] },
      }).lean();

      for (const pr of pendingRequests) {
        pendingRequestMap.set(String(pr.serviceId), pr);
      }
    }

    const formattedServices = allServices.map((srv) => {
      const srvId = String(srv._id);
      const isMapped = activeMappedServiceMap.has(srvId);
      const mappingData = isMapped ? activeMappedServiceMap.get(srvId) : null;

      let skillStatus = "not_added";
      if (techSkillSet.has(srvId)) {
        skillStatus = "approved";
      } else if (pendingRequestMap.has(srvId)) {
        const pr = pendingRequestMap.get(srvId);
        skillStatus = pr.status === "pending" ? "pending_approval" : "rejected";
      }

      return {
        _id: srv._id,
        serviceName: srv.serviceName,
        image: srv.image,
        description: srv.description,
        category: srv.category,
        price: srv.price,
        isAvailableInZone: isMapped,
        pricingMultiplier: mappingData?.pricingMultiplier || 1.0,
        skillStatus,
        hasSkill: techSkillSet.has(srvId),
        canRequestSkill: !techSkillSet.has(srvId) && skillStatus !== "pending_approval",
      };
    });

    const availableServices = formattedServices.filter((s) => s.isAvailableInZone);
    const unavailableServices = formattedServices.filter((s) => !s.isAvailableInZone);

    return res.status(200).json({
      success: true,
      message: "Zone services retrieved successfully",
      result: {
        zone: {
          _id: zone._id,
          name: zone.name,
          zoneCode: zone.zoneCode,
          district: zone.operationalCityId,
        },
        services: formattedServices,
        availableServices,
        unavailableServices,
      },
    });
  } catch (error) {
    console.error("getZoneServicesForTechnician Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching zone services",
      result: { error: error.message },
    });
  }
};

/* ==========================================================================
   📝 STEP 6: SUBMIT TECHNICIAN SKILL / NEW SERVICE REQUEST
   Allows technician to request approval for a new skill/service.
   ========================================================================== */
export const submitTechnicianSkillRequest = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    const authUserId = req.user?.userId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const { serviceId, experienceYears = 0, reason, documentUrls = [], zoneId } = req.body;

    if (!serviceId || !isValidObjectId(serviceId)) {
      return res.status(400).json({
        success: false,
        message: "Valid serviceId is required",
        result: {},
      });
    }

    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: "Reason for requesting the service is required",
        result: {},
      });
    }

    const exp = Number(experienceYears);
    if (!Number.isFinite(exp) || exp < 0 || exp > 15) {
      return res.status(400).json({
        success: false,
        message: "Experience years must be between 0 and 15",
        result: {},
      });
    }

    const serviceDoc = await Service.findById(serviceId).lean();
    if (!serviceDoc || !serviceDoc.isActive) {
      return res.status(404).json({
        success: false,
        message: "Service not found or inactive",
        result: {},
      });
    }

    const techProfile = await TechnicianProfile.findById(technicianProfileId);
    if (!techProfile) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }

    // Check if skill is already approved
    const alreadyHasSkill = (techProfile.skills || []).some(
      (s) => String(s.serviceId) === String(serviceId)
    );
    if (alreadyHasSkill) {
      return res.status(400).json({
        success: false,
        message: "You already have this skill approved on your profile",
        result: {},
      });
    }

    // Check if there is an existing pending request
    const existingPending = await TechnicianSkillRequest.findOne({
      technicianId: technicianProfileId,
      serviceId,
      status: "pending",
    });
    if (existingPending) {
      return res.status(400).json({
        success: false,
        message: "A request for this service is already pending admin review",
        result: { requestId: existingPending._id },
      });
    }

    const effectiveZoneId = zoneId && isValidObjectId(zoneId) ? zoneId : techProfile.cityZoneId;
    const effectiveDistrictId = techProfile.primaryDistrictId || techProfile.primaryCityId;

    const skillRequest = await TechnicianSkillRequest.create({
      technicianId: technicianProfileId,
      userId: authUserId,
      districtId: effectiveDistrictId,
      zoneId: effectiveZoneId,
      serviceId,
      serviceName: serviceDoc.serviceName,
      experienceYears: exp,
      reason: reason.trim(),
      documentUrls: Array.isArray(documentUrls) ? documentUrls : [],
      status: "pending",
    });

    return res.status(201).json({
      success: true,
      message: "Skill request submitted successfully. It will be reviewed by Admin.",
      result: skillRequest,
    });
  } catch (error) {
    console.error("submitTechnicianSkillRequest Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error submitting skill request",
      result: { error: error.message },
    });
  }
};

/* ==========================================================================
   📜 GET MY TECHNICIAN SKILL REQUESTS
   ========================================================================== */
export const getMyTechnicianSkillRequests = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const requests = await TechnicianSkillRequest.find({
      technicianId: technicianProfileId,
    })
      .sort({ createdAt: -1 })
      .populate("serviceId", "serviceName image category price")
      .populate("districtId", "name code")
      .populate("zoneId", "name zoneCode")
      .lean();

    return res.status(200).json({
      success: true,
      message: "Skill requests fetched successfully",
      result: requests,
    });
  } catch (error) {
    console.error("getMyTechnicianSkillRequests Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching skill requests",
      result: { error: error.message },
    });
  }
};

/* ==========================================================================
   👤 CREATE / UPDATE TECHNICIAN PROFILE (ONBOARDING)
   Authoritative GPS & Zone validation, District auto-permissioning, and
   ZoneServiceMapping skill verification.
   ========================================================================== */
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
      districtId,
      primaryDistrictId,
      cityZoneId,
      zoneId,
      latitude,
      longitude,
      location,
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

    // Ensure only users with Technician role can update profile
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Only users with Technician role can update profile",
        result: {},
      });
    }

    const targetDistrictId = primaryDistrictId || districtId;
    const targetZoneId = cityZoneId || zoneId;

    let effectiveLat = latitude;
    let effectiveLng = longitude;
    if ((effectiveLat === undefined || effectiveLng === undefined) && location?.coordinates?.length === 2) {
      effectiveLng = location.coordinates[0];
      effectiveLat = location.coordinates[1];
    }

    const profileUpdate = {};

    // 📍 Authoritative GPS & Zone Validation if coordinates are provided
    if (effectiveLat !== undefined && effectiveLng !== undefined) {
      const lat = Number(effectiveLat);
      const lng = Number(effectiveLng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_COORDINATES",
          message: "Invalid GPS coordinates provided",
          result: {},
        });
      }

      const { district: resolvedDistrict, zone: resolvedZone } =
        await resolveDistrictAndZoneFromCoordinates(lat, lng);

      if (!resolvedDistrict) {
        return res.status(400).json({
          success: false,
          code: "LOCATION_OUTSIDE_SERVICE_AREA",
          message: "Your address GPS coordinates fall outside our operational service areas.",
          result: { latitude: lat, longitude: lng },
        });
      }

      if (targetDistrictId && isValidObjectId(targetDistrictId)) {
        if (resolvedDistrict._id.toString() !== targetDistrictId.toString()) {
          const selectedDist = await OperationalCity.findById(targetDistrictId).select("name").lean();
          return res.status(400).json({
            success: false,
            code: "LOCATION_DISTRICT_MISMATCH",
            message: `Your address GPS is in ${resolvedDistrict.name}, but you selected ${selectedDist?.name || "another district"}. Please select the correct district.`,
            result: {
              resolvedDistrict: { id: resolvedDistrict._id, name: resolvedDistrict.name },
            },
          });
        }
      }

      if (targetZoneId && isValidObjectId(targetZoneId)) {
        if (!resolvedZone || resolvedZone._id.toString() !== targetZoneId.toString()) {
          const selectedZone = await CityZone.findById(targetZoneId).select("name").lean();
          return res.status(400).json({
            success: false,
            code: "LOCATION_ZONE_MISMATCH",
            message: `Your address is located in ${resolvedZone?.name || "an unmapped zone"}, but you selected ${selectedZone?.name || "a different zone"}. Please select the correct service area.`,
            result: {
              resolvedZone: resolvedZone ? { id: resolvedZone._id, name: resolvedZone.name } : null,
              resolvedDistrict: { id: resolvedDistrict._id, name: resolvedDistrict.name },
            },
          });
        }
      }

      // Assign verified geo location & districts
      profileUpdate.location = {
        type: "Point",
        coordinates: [lng, lat],
      };
      profileUpdate.primaryDistrictId = resolvedDistrict._id;
      profileUpdate.primaryCityId = resolvedDistrict._id;
      profileUpdate.cityZoneId = resolvedZone ? resolvedZone._id : (targetZoneId || null);

      // Auto-grant TechnicianDistrictPermission for primary district
      try {
        await TechnicianDistrictPermission.findOneAndUpdate(
          { technicianId: technicianProfileId, districtId: resolvedDistrict._id },
          { $set: { isEnabled: true } },
          { upsert: true, new: true }
        );
      } catch (permErr) {
        console.warn("Auto-grant district permission failed:", permErr.message);
      }
    } else {
      if (targetDistrictId && isValidObjectId(targetDistrictId)) {
        profileUpdate.primaryDistrictId = targetDistrictId;
        profileUpdate.primaryCityId = targetDistrictId;
      }
      if (targetZoneId && isValidObjectId(targetZoneId)) {
        profileUpdate.cityZoneId = targetZoneId;
      }
    }

    // 🏘 Check skills against ZoneServiceMapping if skills are being updated
    if (skills !== undefined && Array.isArray(skills) && skills.length > 0) {
      const activeZoneId = profileUpdate.cityZoneId || (await TechnicianProfile.findById(technicianProfileId).select("cityZoneId").lean())?.cityZoneId;

      if (activeZoneId) {
        const skillServiceIds = skills.map((s) => new mongoose.Types.ObjectId(s.serviceId));
        const approvedMappings = await ZoneServiceMapping.find({
          zoneId: activeZoneId,
          serviceId: { $in: skillServiceIds },
          active: true,
        }).select("serviceId").lean();

        const approvedSet = new Set(approvedMappings.map((m) => String(m.serviceId)));
        const unapprovedIds = skillServiceIds.filter((sid) => !approvedSet.has(String(sid)));

        if (unapprovedIds.length > 0) {
          const unapprovedDocs = await Service.find({ _id: { $in: unapprovedIds } }).select("serviceName").lean();
          const unapprovedNames = unapprovedDocs.map((d) => d.serviceName).join(", ");
          return res.status(400).json({
            success: false,
            code: "SERVICE_NOT_AVAILABLE_IN_ZONE",
            message: `The following services are not available in your service area: ${unapprovedNames}. Please submit a skill request for approval.`,
            result: {
              blockedServiceIds: unapprovedIds.map(String),
              unapprovedNames,
            },
          });
        }
      }

      profileUpdate.skills = skills;
    } else if (skills !== undefined) {
      profileUpdate.skills = skills;
    }

    if (address !== undefined) profileUpdate.address = address;
    if (city !== undefined) profileUpdate.city = city;
    if (state !== undefined) profileUpdate.state = state;
    if (pincode !== undefined) profileUpdate.pincode = pincode;
    if (locality !== undefined) profileUpdate.locality = locality;
    if (experienceYears !== undefined) profileUpdate.experienceYears = experienceYears;
    if (specialization !== undefined) profileUpdate.specialization = specialization;

    const userUpdate = {};
    const u = req.body.user || {};

    const finalFname = fname !== undefined ? fname : u.fname;
    const finalLname = lname !== undefined ? lname : u.lname;
    const finalGender = gender !== undefined ? gender : u.gender;

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

    // 🔒 profileComplete is ALWAYS computed server-side
    const currentTech = await TechnicianProfile.findById(technicianProfileId).lean();
    const effectiveAddress = address !== undefined ? address : currentTech?.address;
    const effectiveCity = city !== undefined ? city : currentTech?.city;
    const effectiveSpecialization = specialization !== undefined ? specialization : currentTech?.specialization;
    const effectiveLocality = locality !== undefined ? locality : currentTech?.locality;
    const effectiveSkills = skills !== undefined ? skills : currentTech?.skills;

    const isComplete = Boolean(
      hasCompleteName &&
      (effectiveAddress || "").trim() &&
      (effectiveCity || "").trim() &&
      (effectiveSpecialization || "").trim() &&
      (effectiveLocality || "").trim() &&
      Array.isArray(effectiveSkills) &&
      effectiveSkills.length > 0
    );
    profileUpdate.profileComplete = isComplete;

    if (finalFname !== undefined) userUpdate.fname = finalFname;
    if (finalLname !== undefined) userUpdate.lname = finalLname;
    if (finalGender !== undefined) userUpdate.gender = finalGender;

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
    )
      .populate("skills.serviceId", "serviceName")
      .populate("primaryDistrictId", "name code")
      .populate("cityZoneId", "name zoneCode")
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
      message: "Technician profile updated successfully",
      result: technician,
    });
  } catch (error) {
    console.error("createTechnician Error:", error);
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
    const { workStatus, search, districtId, district, cityId, city, zoneId, cityZoneId } = req.query;

    const conditions = [];

    // 1. WorkStatus filter (default: exclude deleted)
    if (workStatus) {
      if (!TECHNICIAN_STATUSES.includes(workStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid workStatus filter",
          result: {},
        });
      }
      conditions.push({ workStatus });
    } else {
      conditions.push({ workStatus: { $ne: "deleted" } });
    }

    // 2. District / Operational City filter
    const targetDistrictId = districtId || cityId;
    const targetDistrictName = district || city;

    if (targetDistrictId && mongoose.Types.ObjectId.isValid(targetDistrictId)) {
      const targetObjId = new mongoose.Types.ObjectId(targetDistrictId);

      const distPerms = await TechnicianDistrictPermission.find({
        districtId: targetObjId,
        isEnabled: true,
      }).select("technicianId").lean();

      const permTechIds = distPerms.map((p) => p.technicianId);

      conditions.push({
        $or: [
          { primaryDistrictId: targetObjId },
          { primaryCityId: targetObjId },
          { enabledDistrictIds: targetObjId },
          { allowedCityIds: targetObjId },
          { _id: { $in: permTechIds } },
        ],
      });
    } else if (targetDistrictName && targetDistrictName.trim().length >= 2) {
      const districtRegex = new RegExp(targetDistrictName.trim(), "i");

      const matchedCities = await OperationalCity.find({
        $or: [{ name: districtRegex }, { city: districtRegex }],
      }).select("_id").lean();

      const cityIds = matchedCities.map((c) => c._id);

      const distPerms = await TechnicianDistrictPermission.find({
        districtId: { $in: cityIds },
        isEnabled: true,
      }).select("technicianId").lean();

      const permTechIds = distPerms.map((p) => p.technicianId);

      conditions.push({
        $or: [
          { primaryDistrictId: { $in: cityIds } },
          { primaryCityId: { $in: cityIds } },
          { enabledDistrictIds: { $in: cityIds } },
          { allowedCityIds: { $in: cityIds } },
          { city: districtRegex },
          { locality: districtRegex },
          { _id: { $in: permTechIds } },
        ],
      });
    }

    // 3. City Zone filter
    const targetZoneId = zoneId || cityZoneId;
    if (targetZoneId && mongoose.Types.ObjectId.isValid(targetZoneId)) {
      conditions.push({ enabledCityZoneIds: new mongoose.Types.ObjectId(targetZoneId) });
    }

    // 4. Two-step search query (mobile/name lives on User, not TechnicianProfile)
    if (search && search.trim().length >= 2) {
      const searchRegex = { $regex: search.trim(), $options: "i" };

      const matchingUsers = await mongoose.model("User").find({
        $or: [
          { fname: searchRegex },
          { lname: searchRegex },
          { mobileNumber: searchRegex },
          { email: searchRegex },
        ],
      }).select("_id").lean();

      const matchingUserIds = matchingUsers.map((u) => u._id);

      conditions.push({
        $or: [
          { userId: { $in: matchingUserIds } },
          { locality: searchRegex },
          { specialization: searchRegex },
        ],
      });
    }

    const profileQuery = conditions.length > 1 ? { $and: conditions } : conditions[0] || {};

    const technicians = await TechnicianProfile.find(profileQuery)
      .populate("skills.serviceId", "serviceName")
      .populate({
        path: "userId",
        select: "fname lname gender mobileNumber email lastLoginAt",
      })
      .populate("primaryDistrictId", "name code city state")
      .populate("primaryCityId", "name code city state")
      .populate("enabledDistrictIds", "name code city state")
      .populate("allowedCityIds", "name code city state")
      .populate("enabledCityZoneIds", "name zoneCode operationalCityId")
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

    if (experienceYears !== undefined && experienceYears > 15) {
      return res.status(400).json({ success: false, message: "Experience cannot exceed 15 years", result: {} });
    }

    if (skills !== undefined) {
      if (!validateSkills(skills)) {
        return res.status(400).json({ success: false, message: "Invalid skills format", result: {} });
      }
      const hasOverExperience = skills.some(s => s.experienceYears !== undefined && s.experienceYears > 15);
      if (hasOverExperience) {
        return res.status(400).json({ success: false, message: "Experience cannot exceed 15 years", result: {} });
      }
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

      // phone number updates are ignored as per requirement

      // 4. Calculate Profile Completion
      // 🔒 ALWAYS server-computed — client-supplied profileComplete is ignored
      // (a forged `true` previously bypassed the activation gate).
      const isComplete = Boolean(
        technician.address &&
        technician.city &&
        technician.specialization &&
        technician.locality &&
        technician.skills?.length > 0
      );
      technician.profileComplete = isComplete;
      userUpdate.profileComplete = isComplete;
      userUpdated = true;

      if (userUpdated) {
        await mongoose.model("User").findByIdAndUpdate(userId, userUpdate, { session, runValidators: true });
      }

      await technician.save({ session });
    });

    // 5. Proactive Broadcast if technician went online; remove from GEO if offline
    if (availability?.isOnline === true) {
      broadcastPendingJobsToTechnician(technicianProfileId, req.io).catch(err =>
        console.error("Proactive broadcast error:", err)
      );
    } else if (availability?.isOnline === false) {
      // Remove from Redis GEO set so matching doesn't find stale positions
      const { geoRemove } = await import("../Utils/technicianGeo.js");
      geoRemove(technicianProfileId).catch(() => {});
    }

    // 🏘 ZONE RESOLUTION — assign technician to a city zone based on their location.
    // Runs after every profile update so zone is always fresh.
    try {
      const freshProfile = await TechnicianProfile.findById(technicianProfileId)
        .select("location cityZoneId")
        .lean();

      if (freshProfile?.location?.coordinates) {
        const [lng, lat] = freshProfile.location.coordinates;
        const { zone } = await resolveZoneFromCoordinates(lat, lng);
        const newZoneId = zone ? zone._id : null;
        const currentZoneId = freshProfile.cityZoneId
          ? String(freshProfile.cityZoneId)
          : null;
        const newZoneIdStr = newZoneId ? String(newZoneId) : null;

        if (currentZoneId !== newZoneIdStr) {
          await TechnicianProfile.updateOne(
            { _id: technicianProfileId },
            {
              $set: {
                cityZoneId: newZoneId,
                zoneMismatch: false,
                zoneMismatchSince: null,
              },
            }
          );
          console.log(`🏘 Tech ${technicianProfileId} assigned to zone ${newZoneId || "none"}`);
        }
      }
    } catch (zoneErr) {
      // Zone resolution is best-effort
      console.error("Zone resolution error:", zoneErr.message);
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

    // 🔐 Session invalidation (Socket Analysis B1.5): a suspended/deleted
    // technician's connected sockets must be revoked NOW — their JWT claims
    // are frozen until re-auth, so only a forced disconnect stops alerts.
    if (workStatus === "suspended" || workStatus === "deleted") {
      revokeSocketSession(req.io, technicianId, `workStatus: ${workStatus}`);
    }

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

    // 🔐 Session invalidation: training revocation must kill the live socket
    // so the tech stops receiving job alerts until re-approval.
    if (!trainingCompleted) {
      revokeSocketSession(req.io, technicianId, "trainingCompleted: false");
    }

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
