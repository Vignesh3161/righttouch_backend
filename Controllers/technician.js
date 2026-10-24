import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import User from "../Schemas/User.js";
import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import { broadcastPendingJobsToTechnician } from "../Utils/technicianMatching.js";
import { handleLocationUpdate, revalidateActiveBroadcasts } from "../Utils/technicianLocation.js";
import { getGpsState, normalizeCoordinates } from "../Utils/locationConfig.js";
import { revokeSocketSession } from "../Utils/socketSessionControl.js";
import {
  resolveZoneFromCoordinates,
  resolveDistrictAndZoneFromCoordinates,
} from "../Utils/resolveZoneFromCoordinates.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import { getAvailabilitySnapshot } from "../Services/serviceAvailabilityService.js";
import CityZone from "../Schemas/CityZone.js";
import TechnicianSkillRequest from "../Schemas/TechnicianSkillRequest.js";
import { getDekForKycDoc, decryptBankDetails } from "../Utils/kycFieldCrypto.js";
import { maskAccount } from "../Utils/kycPrivacy.js";

const getTechnicianPermissionZoneIds = (technician) =>
  [...new Set((technician?.enabledCityZoneIds || []).map((z) => String(z._id || z)).filter(Boolean))];

// Strict mapping gate shared by onboarding, profile update and add-skills.
// Returns service IDs that have no active mapping in any of the technician's
// permitted zones. No zones yet (onboarding) => allow profile skills; job
// eligibility will still block until a zone is granted.
const findSkillsBlockedByZone = async ({ technician, serviceIds }) => {
  const zoneIds = getTechnicianPermissionZoneIds(technician);
  if (!zoneIds.length || !serviceIds.length) return [];

  const mappings = await ZoneServiceMapping.find({
    zoneId: { $in: zoneIds },
    serviceId: { $in: serviceIds },
    active: true,
  })
    .select("serviceId")
    .lean();

  const approved = new Set(mappings.map((m) => String(m.serviceId)));
  return serviceIds
    .map((id) => String(id?._id || id))
    .filter((id) => !approved.has(id));
};

// C3: masked-bank policy for ordinary list/detail responses. Full bank values
// are only returned to the owning technician (self-service) or via the audited
// KYC full-PII endpoint; everyone else sees masked values.
const maskHolderName = (name) => {
  if (!name) return name;
  const s = String(name).trim();
  if (s.length <= 1) return "***";
  return `${s[0]}***`;
};

const maskUpiId = (upi) => {
  if (!upi) return upi;
  const s = String(upi);
  const at = s.lastIndexOf("@");
  if (at <= 0) return maskAccount(s);
  return `***${s.slice(at)}`;
};

const maskIfscCode = (ifsc) => {
  if (!ifsc) return ifsc;
  const s = String(ifsc);
  if (s.length <= 4) return "****";
  return `${s.slice(0, 4)}***`;
};

const sanitizeBankDetails = (bank, { full = false } = {}) => {
  if (!bank) return bank;
  if (full) return bank;
  const masked = {
    ...bank,
    accountHolderName: maskHolderName(bank.accountHolderName ?? bank.accountName),
    accountNumber: maskAccount(bank.accountNumber),
    ifscCode: maskIfscCode(bank.ifscCode),
    upiId: maskUpiId(bank.upiId),
  };
  // Legacy alias: never leave the unmasked holder name beside the masked one.
  if (masked.accountName && masked.accountName !== masked.accountHolderName) {
    masked.accountName = masked.accountHolderName;
  }
  return masked;
};

import OperationalCity from "../Schemas/OperationalCity.js";
import { containsRegex } from "../Utils/safeQuery.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import { ensureApprovedDistrictZones } from "../Services/technicianDistrictService.js";

// ================= UPDATE TECHNICIAN LIVE LOCATION ================= //sk
export const updateTechnicianLocation = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    const { latitude, longitude } = req.body;

    if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }
    const coords = normalizeCoordinates(latitude, longitude);
    if (!coords.valid) {
      return res.status(400).json({
        success: false,
        code: "INVALID_COORDINATES",
        message: "Invalid coordinates",
        result: {},
      });
    }

    const result = await handleLocationUpdate(technicianProfileId, coords.latitude, coords.longitude, req.io, "http");

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
// C3: `includeFullBank` defaults to false — ordinary callers receive MASKED
// bank values. Pass `includeFullBank: true` only for the owning technician's
// self-service read. Never log decrypted values (only the technician id).
const enrichTechnicianWithActivationStatus = async (technicianDoc, opts = {}) => {
  const { includeFullBank = false } = opts || {};
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
        const fullBank = {
          accountHolderName: plainBank.accountHolderName || techObj.bankDetails?.accountName || techObj.bankDetails?.accountHolderName || null,
          accountNumber: plainBank.accountNumber || techObj.bankDetails?.accountNumber || null,
          bankName: plainBank.bankName || techObj.bankDetails?.bankName || null,
          branchName: plainBank.branchName || techObj.bankDetails?.branchName || null,
          ifscCode: plainBank.ifscCode || techObj.bankDetails?.ifscCode || null,
          upiId: plainBank.upiId || techObj.bankDetails?.upiId || null,
        };
        techObj.bankDetails = sanitizeBankDetails(fullBank, { full: includeFullBank });
        techObj.isBankVerified = isBankVerified;
        techObj.bankVerified = isBankVerified;
      } catch (decErr) {
        console.error("Error decrypting bank details for tech:", technicianDoc._id, decErr.message);
      }
    } else if (techObj.bankDetails) {
      // Legacy profile-level bank details — mask them the same way.
      techObj.bankDetails = sanitizeBankDetails(techObj.bankDetails, { full: includeFullBank });
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

    // Strict per-zone mapping: no active mapping = not available, regardless
    // of the legacy zoneRestricted flag.
    {
      const blockedIds = await findSkillsBlockedByZone({
        technician,
        serviceIds: serviceObjectIds,
      });
      if (blockedIds.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Some services are not available in your zone",
          result: { blockedServiceIds: blockedIds },
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

    // B-14: inactive-aware resolution — GPS inside a deactivated zone is
    // reported explicitly instead of collapsing to a generic mismatch.
    const { district: resolvedDistrict, zone: resolvedZone } =
      await resolveDistrictAndZoneFromCoordinates(lat, lng, { includeInactiveZone: true });

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

    if (resolvedZone && resolvedZone.active === false) {
      return res.status(400).json({
        success: false,
        code: "LOCATION_ZONE_INACTIVE",
        message: `Your GPS location falls in ${resolvedZone.name || "a zone"} (${resolvedDistrict.name}), which is currently inactive. Registration requires an active micro-zone.`,
        result: {
          resolvedZone: { id: resolvedZone._id, name: resolvedZone.name },
          resolvedDistrict: { id: resolvedDistrict._id, name: resolvedDistrict.name },
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

    // If authenticated technician and zoneId not passed in query, use an
    // explicitly granted zone. Registered cityZoneId alone is not authorization.
    if (!zoneId && req.user?.technicianProfileId) {
      const tech = await TechnicianProfile.findById(req.user.technicianProfileId)
        .select("enabledCityZoneIds")
        .lean();
      zoneId = tech?.enabledCityZoneIds?.[0];
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

    // Availability is the canonical resolver result for this exact zone,
    // not merely the existence of a mapping row.
    const districtId = zone.operationalCityId?._id || zone.operationalCityId;
    const availabilitySnapshot = await getAvailabilitySnapshot({
      serviceIds: allServices.map((s) => s._id),
      districtIds: districtId ? [districtId] : [],
      zoneIds: [zone._id],
    });

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
      const mappingData = activeMappedServiceMap.get(srvId) || null;
      const isMapped = Boolean(mappingData);
      const evaluation = availabilitySnapshot.evaluate(srv._id, districtId, zone._id);

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
        isAvailableInZone: evaluation.available,
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

      // B-14: inactive-aware resolution so GPS inside a deactivated zone
      // yields an explicit LOCATION_ZONE_INACTIVE (not a generic mismatch).
      const { district: resolvedDistrict, zone: resolvedZone } =
        await resolveDistrictAndZoneFromCoordinates(lat, lng, { includeInactiveZone: true });

      if (!resolvedDistrict) {
        return res.status(400).json({
          success: false,
          code: "LOCATION_OUTSIDE_SERVICE_AREA",
          message: "Your address GPS coordinates fall outside our operational service areas.",
          result: { latitude: lat, longitude: lng },
        });
      }

      if (resolvedZone && resolvedZone.active === false) {
        return res.status(400).json({
          success: false,
          code: "LOCATION_ZONE_INACTIVE",
          message: `The service area covering your address (${resolvedZone.name || "zone"}) is currently inactive. Please choose an address in an active zone.`,
          result: {
            resolvedZone: { id: resolvedZone._id, name: resolvedZone.name },
            resolvedDistrict: { id: resolvedDistrict._id, name: resolvedDistrict.name },
          },
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

      // Assign verified geo location & districts (location context ONLY —
      // B-03: GPS must never create an authorized district grant. Operational
      // access requires the Admin/Owner grant workflow (addDistrictPermission),
      // which records enabledBy/enabledAt provenance. Registration leaves
      // primaryDistrictId/cityZoneId as unprivileged location metadata.
      profileUpdate.location = {
        type: "Point",
        coordinates: [lng, lat],
      };
      profileUpdate.primaryDistrictId = resolvedDistrict._id;
      profileUpdate.primaryCityId = resolvedDistrict._id;
      profileUpdate.cityZoneId = resolvedZone ? resolvedZone._id : (targetZoneId || null);
    } else {
      if (targetDistrictId && isValidObjectId(targetDistrictId)) {
        profileUpdate.primaryDistrictId = targetDistrictId;
        profileUpdate.primaryCityId = targetDistrictId;
      }
      if (targetZoneId && isValidObjectId(targetZoneId)) {
        profileUpdate.cityZoneId = targetZoneId;
      }
    }

    // Strict per-zone mapping gate for skill updates.
    if (skills !== undefined && Array.isArray(skills) && skills.length > 0) {
      const techDoc = await TechnicianProfile.findById(technicianProfileId)
        .select("enabledCityZoneIds")
        .lean();
      const skillServiceIds = skills.map((s) => new mongoose.Types.ObjectId(s.serviceId));
      const unapprovedIds = await findSkillsBlockedByZone({
        technician: techDoc,
        serviceIds: skillServiceIds,
      });

      if (unapprovedIds.length > 0) {
        const unapprovedDocs = await Service.find({ _id: { $in: unapprovedIds } }).select("serviceName").lean();
        const unapprovedNames = unapprovedDocs.map((d) => d.serviceName).join(", ");
        return res.status(400).json({
          success: false,
          code: "SERVICE_NOT_AVAILABLE_IN_ZONE",
          message: `The following services are not available in your service area: ${unapprovedNames}. Please submit a skill request for approval.`,
          result: {
            blockedServiceIds: unapprovedIds,
            unapprovedNames,
          },
        });
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
// C3: Admin/Owner-only listing (route-gated), bounded pagination, masked bank
// details. `result` stays an array so existing response contracts hold; page
// metadata is additive via `meta`.
export const getAllTechnicians = async (req, res) => {
  try {
    const { workStatus, search, districtId, district, cityId, city, zoneId, cityZoneId } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

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
      const districtRegex = containsRegex(targetDistrictName);

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

    // 3. City Zone filter — strict: only Admin-approved enabledCityZoneIds.
    // Registration zone (cityZoneId) alone does not qualify.
    const targetZoneId = zoneId || cityZoneId;
    if (targetZoneId && mongoose.Types.ObjectId.isValid(targetZoneId)) {
      const zoneObjId = new mongoose.Types.ObjectId(targetZoneId);
      conditions.push({ enabledCityZoneIds: zoneObjId });
    }

    // 4. Two-step search query (mobile/name lives on User, not TechnicianProfile)
    if (search && search.trim().length >= 2) {
      const searchRegex = containsRegex(search);

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

    const total = await TechnicianProfile.countDocuments(profileQuery);
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
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Enrich each technician with activation status AND enforce online prerequisites.
    // C3: masked bank details on listing responses — never full values.
    const enrichedTechnicians = await Promise.all(
      technicians.map(async (tech) => {
        const enriched = await enrichTechnicianWithActivationStatus(tech, { includeFullBank: false });
        const enforced = await enforceOnlinePrerequisites(enriched);
        return enforced;
      })
    );

    return res.status(200).json({
      success: true,
      message: "Technicians fetched successfully",
      result: enrichedTechnicians,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 0,
      },
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
// C3: self-or-privileged read. A technician may read only their own profile
// via this endpoint; Admin/Owner may read any. Bank details are masked except
// for the owning technician's own read (self-service preserved).
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

    const viewerRole = req.user?.role;
    const isPrivileged = viewerRole === "Admin" || viewerRole === "Owner";
    const isSelf =
      req.user?.technicianProfileId && String(req.user.technicianProfileId) === String(id);
    if (!isPrivileged && !isSelf) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
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
    const enrichedTechnician = await enrichTechnicianWithActivationStatus(technician, {
      includeFullBank: Boolean(isSelf),
    });
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
    // C3: self-service read — the owning technician keeps full bank access.
    const enrichedTechnician = await enrichTechnicianWithActivationStatus(technician, {
      includeFullBank: true,
    });
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

    if (skills !== undefined && Array.isArray(skills) && skills.length > 0) {
      const skillServiceIds = skills.map((s) => new mongoose.Types.ObjectId(s.serviceId));
      const blockedIds = await findSkillsBlockedByZone({ technician, serviceIds: skillServiceIds });
      if (blockedIds.length > 0) {
        const blockedDocs = await Service.find({ _id: { $in: blockedIds } }).select("serviceName").lean();
        const blockedNames = blockedDocs.map((d) => d.serviceName).join(", ");
        return res.status(400).json({
          success: false,
          code: "SERVICE_NOT_AVAILABLE_IN_ZONE",
          message: `The following services are not available in your service area: ${blockedNames}. Please submit a skill request for approval.`,
          result: { blockedServiceIds: blockedIds, unapprovedNames: blockedNames },
        });
      }
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

          if (technician.availability.isOnline !== true) {
            const gps = getGpsState(technician, "BROADCAST");
            if (!gps.valid || !gps.fresh) {
              const error = new Error("A fresh GPS location is required before going online");
              error.statusCode = 409;
              error.code = gps.valid ? "GPS_STALE" : "GPS_REQUIRED";
              error.details = {
                reason: gps.reason,
                ageSeconds: gps.ageSeconds,
                thresholdSeconds: gps.thresholdSeconds,
              };
              throw error;
            }
          }
        }
        technician.availability.isOnline = Boolean(availability.isOnline);
        if (availability.isOnline) {
          technician.availability.offlineReason = null;
          technician.availability.offlineAt = null;
        }
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
    let broadcastResult = null;
    if (availability?.isOnline === true) {
      broadcastResult = await broadcastPendingJobsToTechnician(technicianProfileId, req.io).catch((err) => ({
        success: false,
        message: err.message,
      }));
    } else if (availability?.isOnline === false) {
      // Remove from Redis GEO set so matching doesn't find stale positions
      const { geoRemove } = await import("../Utils/technicianGeo.js");
      geoRemove(technicianProfileId).catch(() => {});
      
      // 🔄 Revalidate active broadcasts - technician went offline
      await revalidateActiveBroadcasts(technicianProfileId, 
        technician.location?.coordinates?.[1] || 0, 
        technician.location?.coordinates?.[0] || 0, 
        req.io
      ).catch(err => console.error("Offline revalidation error:", err));
    }

    // 🏘 ZONE RESOLUTION — assign technician to a city zone based on their location.
    // Runs after every profile update so zone is always fresh.
    try {
      const freshProfile = await TechnicianProfile.findById(technicianProfileId)
        .select("location cityZoneId")
        .lean();

      if (freshProfile?.location?.coordinates) {
        const [lng, lat] = freshProfile.location.coordinates;
        // B-14: inactive-aware resolution. Registration assignment is owned
        // by admin flows — it is only auto-adopted when live GPS sits in an
        // ACTIVE zone that differs. Inactive-zone or outside-coverage GPS
        // never nulls or rewrites the stored registration (deactivation must
        // not silently destroy it; dispatch eligibility live-resolves anyway).
        const { zone } = await resolveZoneFromCoordinates(lat, lng, { includeInactive: true });
        const currentZoneId = freshProfile.cityZoneId
          ? String(freshProfile.cityZoneId)
          : null;

        if (zone && zone.active !== false) {
          const newZoneIdStr = String(zone._id);
          if (currentZoneId !== newZoneIdStr) {
            await TechnicianProfile.updateOne(
              { _id: technicianProfileId },
              {
                $set: {
                  cityZoneId: zone._id,
                  zoneMismatch: false,
                  zoneMismatchSince: null,
                },
              }
            );
            console.log(`🏘 Tech ${technicianProfileId} assigned to zone ${zone._id}`);
          }
        } else if (!zone) {
          console.log(`🏘 Tech ${technicianProfileId} GPS outside all zones — registration kept (${currentZoneId || "none"})`);
        } else {
          console.log(`🏘 Tech ${technicianProfileId} GPS inside inactive zone ${zone._id} — registration kept (${currentZoneId || "none"})`);
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
      broadcast: broadcastResult,
    });

  } catch (error) {
    if (res.headersSent) return;
    console.error("Update technician error:", error);
    return res.status(error.statusCode || 400).json({
      success: false,
      code: error.code,
      message: error.message,
      result: { error: error.message, ...(error.details || {}) }
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

    if (workStatus === "approved") {
      try {
        await ensureApprovedDistrictZones({
          technicianId: technician._id,
          adminUserId: req.user?.userId,
          reason: "Technician workStatus approved",
        });
      } catch (districtErr) {
        return res.status(districtErr.statusCode || 400).json({
          success: false,
          message: districtErr.message,
          code: districtErr.code || "DISTRICT_ZONE_REQUIRED",
          result: {},
        });
      }
    }

    await technician.save();

    // 🔐 Session invalidation (Socket Analysis B1.5): a suspended/deleted
    // technician's connected sockets must be revoked NOW — their JWT claims
    // are frozen until re-auth, so only a forced disconnect stops alerts.
    if (workStatus === "suspended" || workStatus === "deleted") {
      revokeSocketSession(req.io, technicianId, `workStatus: ${workStatus}`);
    }

    // 🔄 Revalidate active broadcasts for this technician (work status changed)
    const { revalidateActiveBroadcasts } = await import("../Utils/technicianLocation.js");
    if (technician.location?.coordinates) {
      const [lng, lat] = technician.location.coordinates;
      await revalidateActiveBroadcasts(technicianId, lat, lng, req.io)
        .catch(err => console.error("Work status change revalidation error:", err));
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
