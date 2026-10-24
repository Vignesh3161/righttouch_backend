import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import { resolveOperationalCityFromCoordinates } from "../Utils/technicianMatching.js";
import { resolveServiceAvailability } from "./serviceAvailabilityService.js";
import { haversineMeters } from "../Utils/feasibility.js";
import { getGpsState } from "../Utils/locationConfig.js";

const MAX_JOB_DISTANCE_KM = 10;
const MAX_JOB_DISTANCE_METERS = 10000;
// Platform ceiling for per-technician service radius (mirrors the
// TechnicianProfile.serviceRadiusKm schema max). Prefilters must cover up
// to this ceiling so they never discard a technician the final gate passes.
export const MAX_SERVICE_RADIUS_KM = 100;
export const MAX_PREFILTER_RADIUS_M = MAX_SERVICE_RADIUS_KM * 1000;

/**
 * Get allowed district IDs for a technician (primary + enabled + allowed)
 */
export const getAllowedDistrictIds = (tech) => {
  if (!tech) return [];
  // Primary district is registration metadata, NOT authorization. Only the
  // explicit derived grant arrays authorize work.
  const allowedProfile = [
    ...(tech.enabledDistrictIds || []),
    ...(tech.allowedCityIds || []),
  ].map((d) => String(d._id || d));
  return Array.from(new Set(allowedProfile.filter(Boolean)));
};

/**
 * Get allowed zone IDs for a technician — REQUIRED ARCHITECTURE:
 * Registration (cityZoneId/currentCityZoneId) NEVER grants permission.
 * Only Admin-approved enabledCityZoneIds grant job eligibility.
 * Use getRegistrationZoneIds() for display/candidate purposes.
 */
export const getAllowedZoneIds = (tech) => {
  if (!tech) return [];
  const ids = [...(tech.enabledCityZoneIds || [])].map((z) => String(z._id || z));
  return Array.from(new Set(ids.filter(Boolean)));
};

/** Registration/current zones (display only — not permission). */
export const getRegistrationZoneIds = (tech) => {
  if (!tech) return [];
  const ids = [
    ...(tech.cityZoneId ? [tech.cityZoneId] : []),
    ...(tech.currentCityZoneId ? [tech.currentCityZoneId] : []),
  ].map((z) => String(z._id || z));
  return Array.from(new Set(ids.filter(Boolean)));
};

/**
 * Check if technician has district permission for a target district
 */
export const hasDistrictPermission = (tech, targetDistrictId) => {
  if (!targetDistrictId) return true;
  if (!tech) return false;
  const allowed = getAllowedDistrictIds(tech);
  return allowed.includes(String(targetDistrictId._id || targetDistrictId));
};

/**
 * Check if technician has zone permission for a target zone
 * CRITICAL FIX: Only allow if zone is explicitly configured.
 * Empty/non-existent enabledCityZoneIds = DENY (not allow all)
 */
export const hasZonePermission = (tech, targetZoneId) => {
  if (!targetZoneId) return true;
  if (!tech) return false;
  const allowedZones = getAllowedZoneIds(tech);
  if (allowedZones.length === 0) return false; // No zone config = DENY
  return allowedZones.includes(String(targetZoneId._id || targetZoneId));
};

/**
 * Check if technician's current physical GPS district matches allowed districts
 */
export const checkCurrentDistrictMatch = async (tech, targetDistrictId) => {
  if (!tech?.location?.coordinates) return { match: true, currentDistrictId: null };
  if (!targetDistrictId) return { match: true, currentDistrictId: null };
  
  const [techLng, techLat] = tech.location.coordinates;
  const currentCity = await resolveOperationalCityFromCoordinates(techLat, techLng);
  const currentDistIdStr = currentCity?._id ? String(currentCity._id) : null;
  
  if (!currentDistIdStr) return { match: true, currentDistrictId: null };
  
  const allowed = getAllowedDistrictIds(tech);
  const match = allowed.includes(currentDistIdStr);
  
  return { match, currentDistrictId: currentDistIdStr };
};

/**
 * Check if technician's current physical GPS zone matches allowed zones
 */
export const checkCurrentZoneMatch = async (tech, targetZoneId) => {
  if (!tech?.location?.coordinates) return { match: true, currentZoneId: null };
  if (!targetZoneId) return { match: true, currentZoneId: null };
  
  const [techLng, techLat] = tech.location.coordinates;
  const currentZone = await CityZone.findOne({
    polygon: { $geoIntersects: { $geometry: { type: "Point", coordinates: [techLng, techLat] } } },
    active: true,
  }).select("_id").lean();
  
  const currentZoneIdStr = currentZone?._id ? String(currentZone._id) : null;
  // Fail closed: a zoned booking can only be served when the technician's
  // live GPS is demonstrably inside their permitted zone.
  if (!currentZoneIdStr) return { match: false, currentZoneId: null };

  const match = getAllowedZoneIds(tech).includes(currentZoneIdStr);
  
  return { match, currentZoneId: currentZoneIdStr };
};

/**
 * Calculate distance between technician and job in meters
 * Uses single canonical haversine calculation
 */
export const calculateDistanceMeters = (techLocation, jobLocation) => {
  if (!techLocation?.coordinates || !jobLocation?.coordinates) return null;
  
  const [techLng, techLat] = techLocation.coordinates;
  const [jobLng, jobLat] = jobLocation.coordinates;
  
  if (!Number.isFinite(techLat) || !Number.isFinite(techLng) || 
      !Number.isFinite(jobLat) || !Number.isFinite(jobLng)) return null;
  
  return haversineMeters(
    { latitude: techLat, longitude: techLng },
    { latitude: jobLat, longitude: jobLng }
  );
};

/**
 * Get effective radius for technician (per-tech config or global default)
 */
export const getEffectiveRadiusMeters = (tech) => {
  const configured = Number(tech?.serviceRadiusKm);
  const radiusKm = Number.isFinite(configured) && configured > 0 ? Math.min(configured, MAX_SERVICE_RADIUS_KM) : MAX_JOB_DISTANCE_KM;
  return Math.round(radiusKm * 1000);
};

/**
 * 🎯 SINGLE AUTHORITATIVE ELIGIBILITY ENGINE
 * 
 * Used by BOTH broadcast matching and acceptance validation.
 * Mode parameter controls strictness:
 * - "BROADCAST": 90s GPS freshness, strict zone/district
 * - "ACCEPT": 15min GPS grace, re-validates everything
 * - "FETCH": Same as BROADCAST but for job feed refresh
 * 
 * @param {Object} params
 * @param {Object|string} params.technician - TechnicianProfile doc or ID
 * @param {Object} params.booking - ServiceBooking doc (required)
 * @param {string} params.mode - "BROADCAST" | "ACCEPT" | "FETCH"
 * @param {Object} [params.context] - Booking-level precomputed data shared by
 *   every candidate (jobDistrictId, jobZoneId, serviceAvailability). Passing
 *   it avoids repeating the same availability/geo reads for each candidate.
 * @param {Object} [params.context.currentDistrictCheck] - optional precomputed
 *   result of checkCurrentDistrictMatch for this technician.
 * @param {Object} [params.context.currentZoneCheck] - optional precomputed
 *   result of checkCurrentZoneMatch for this technician.
 * @returns {Promise<Object>} { eligible, reasons, details, distanceMeters, effectiveRadiusMeters }
 */
export const evaluateTechnicianEligibility = async ({
  technician,
  booking,
  mode = "BROADCAST",
  context = null,
}) => {
  const reasons = [];
  const details = {
    serviceAvailable: false,
    districtPermission: false,
    currentDistrictMatch: false,
    zonePermission: false,
    currentZoneMatch: true,
    online: false,
    verified: false,
    hasSkill: false,
    gpsFresh: false,
    validGps: false,
    trainingComplete: false,
    kycVerified: false,
    bankVerified: false,
    distanceMeters: null,
    distanceKm: null,
    effectiveRadiusMeters: MAX_JOB_DISTANCE_METERS,
    radiusPassed: false,
    technicianDistrictIds: [],
    currentDistrictId: null,
    jobDistrictId: null,
    jobZoneId: null,
    feasibility: null,
  };

  // Load technician profile if ID passed
  let tech = technician;
  if (typeof technician === "string" || technician instanceof mongoose.Types.ObjectId) {
    tech = await TechnicianProfile.findById(technician).lean();
  } else if (technician && typeof technician.toObject === "function") {
    tech = technician.toObject();
  }

  if (!tech) {
    reasons.push("TECHNICIAN_NOT_FOUND");
    return { eligible: false, reasons, details };
  }

  // Extract job location
  const jobLat = booking.location?.coordinates?.[1];
  const jobLng = booking.location?.coordinates?.[0];
  const hasJobCoords = Number.isFinite(jobLat) && Number.isFinite(jobLng);

  // 1. RESOLVE JOB DISTRICT/ZONE
  const shared = context || {};
  const hasShared = (key) => Object.prototype.hasOwnProperty.call(shared, key);
  let targetDistrictId = booking.districtId ? String(booking.districtId._id || booking.districtId) : null;
  let targetZoneId = booking.cityZoneId ? String(booking.cityZoneId._id || booking.cityZoneId) : null;

  if (!targetDistrictId && hasJobCoords && !hasShared("jobDistrictId")) {
    const resolvedCity = await resolveOperationalCityFromCoordinates(jobLat, jobLng);
    if (resolvedCity?._id) targetDistrictId = String(resolvedCity._id);
  }
  if (!targetZoneId && hasJobCoords && !hasShared("jobZoneId")) {
    const resolvedZone = await CityZone.findOne({
      polygon: { $geoIntersects: { $geometry: { type: "Point", coordinates: [jobLng, jobLat] } } },
      active: true,
    }).select("_id").lean();
    if (resolvedZone?._id) targetZoneId = String(resolvedZone._id);
  }

  if (!targetDistrictId && hasShared("jobDistrictId")) targetDistrictId = shared.jobDistrictId;
  if (!targetZoneId && hasShared("jobZoneId")) targetZoneId = shared.jobZoneId;

  details.jobDistrictId = targetDistrictId;
  details.jobZoneId = targetZoneId;

  // 2. SERVICE AVAILABILITY AT JOB LOCATION
  if (booking.serviceId && targetDistrictId) {
    const avail = shared.serviceAvailability || await resolveServiceAvailability({
      serviceId: booking.serviceId._id || booking.serviceId,
      districtId: targetDistrictId,
      cityZoneId: targetZoneId,
    });
    details.serviceAvailable = avail.available;
    if (!avail.available) {
      const primaryReason = avail.reason || "SERVICE_NOT_AVAILABLE";
      if (!reasons.includes(primaryReason)) reasons.push(primaryReason);
      if ((avail.code === "SERVICE_DISABLED" || avail.code === "ZONE_RESTRICTION" || avail.status === "DISABLED") &&
          !reasons.includes("SERVICE_DISABLED")) {
        reasons.push("SERVICE_DISABLED");
      }
    }
  } else {
    details.serviceAvailable = true;
  }

  // 3. TECHNICIAN WORK STATUS & PREREQUISITES
  // Same gates as technicianActivation.checkTechnicianActivation so job feeds,
  // socket alerts, broadcast and accept can never disagree.
  const isApproved = tech.workStatus === "approved";
  const profileComplete = tech.profileComplete === true;
  const trainingComplete = tech.trainingCompleted === true;
  let kyc = shared.technicianKyc;
  if (kyc === undefined && shared.kycByTechId) {
    kyc = shared.kycByTechId.get(String(tech._id));
  }
  if (kyc === undefined) {
    kyc = await TechnicianKyc.findOne({ technicianId: tech._id })
      .select("verificationStatus bankVerified bankVerificationStatus kycVerified")
      .lean();
  }
  const kycVerified = Boolean(kyc && (kyc.verificationStatus === "approved" || kyc.kycVerified === true));
  const bankVerified = Boolean(kyc && (kyc.bankVerified === true || kyc.bankVerificationStatus === "approved"));
  details.trainingComplete = trainingComplete;
  details.kycVerified = kycVerified;
  details.bankVerified = bankVerified;
  details.verified = isApproved && profileComplete && trainingComplete && kycVerified && bankVerified;

  if (tech.workStatus === "suspended") {
    reasons.push("TECHNICIAN_SUSPENDED");
  } else if (!isApproved || !profileComplete) {
    reasons.push("TECHNICIAN_NOT_VERIFIED");
  }
  if (!trainingComplete) reasons.push("TRAINING_INCOMPLETE");
  if (!kycVerified) reasons.push("KYC_NOT_VERIFIED");
  if (!bankVerified) reasons.push("BANK_NOT_VERIFIED");

  // 4. TECHNICIAN ONLINE STATUS
  details.online = tech.availability?.isOnline === true;
  if (!details.online) reasons.push("TECHNICIAN_OFFLINE");

  // 5. SERVICE SKILL CHECK
  if (booking.serviceId) {
    const targetServiceIdStr = String(booking.serviceId._id || booking.serviceId);
    const hasSkill = (tech.skills || []).some((s) => {
      const sid = String(s.serviceId?._id || s.serviceId);
      return sid === targetServiceIdStr;
    });
    details.hasSkill = hasSkill;
    if (!hasSkill) reasons.push("SERVICE_SKILL_MISSING");
  }

  // 6. GPS VALIDITY & FRESHNESS (mode-dependent threshold)
  const gps = getGpsState(tech, mode);
  details.validGps = gps.valid;
  details.gpsFresh = gps.fresh;
  details.gpsReason = gps.reason;
  details.gpsAgeSeconds = gps.ageSeconds;
  details.gpsThresholdSeconds = gps.thresholdSeconds;
  if (!gps.valid) {
    reasons.push("MISSING_LOCATION");
  } else if (gps.thresholdSeconds > 0) {
    if (!gps.hasTimestamp) {
      // Keep GPS_STALE for backward compatibility but expose the precise cause.
      if (!reasons.includes("GPS_TIMESTAMP_MISSING")) reasons.push("GPS_TIMESTAMP_MISSING");
      if (!reasons.includes("GPS_STALE")) reasons.push("GPS_STALE");
    } else if (!gps.fresh && !reasons.includes("GPS_STALE")) {
      reasons.push("GPS_STALE");
    }
  }

  // 8. DISTRICT PERMISSION
  const allowedDistrictIds = getAllowedDistrictIds(tech);
  details.technicianDistrictIds = allowedDistrictIds;
  
  if (targetDistrictId) {
    details.districtPermission = allowedDistrictIds.includes(targetDistrictId);
    if (!details.districtPermission) reasons.push("DISTRICT_PERMISSION_DENIED");
  } else {
    details.districtPermission = allowedDistrictIds.length > 0;
  }

  // 9. CURRENT PHYSICAL GPS DISTRICT MATCH
  if (details.validGps && targetDistrictId) {
    const { match, currentDistrictId } = shared.currentDistrictCheck ||
      await checkCurrentDistrictMatch(tech, targetDistrictId);
    details.currentDistrictMatch = match;
    details.currentDistrictId = currentDistrictId;
    if (!match) reasons.push("CURRENT_LOCATION_OUTSIDE_DISTRICT");
  }

  // 10. ZONE PERMISSION
  if (targetZoneId) {
    details.zonePermission = hasZonePermission(tech, targetZoneId);
    if (!details.zonePermission) reasons.push("ZONE_PERMISSION_DENIED");
  } else {
    // No zone context for this job → zone gate passes (district gate still applies)
    details.zonePermission = true;
  }

  // 11. CURRENT PHYSICAL GPS ZONE MATCH
  if (details.validGps && targetZoneId) {
    const { match, currentZoneId } = shared.currentZoneCheck ||
      await checkCurrentZoneMatch(tech, targetZoneId);
    details.currentZoneMatch = match;
    // Only add reason if zone permission was explicitly configured
    if (!match && getAllowedZoneIds(tech).length > 0) {
      reasons.push("CURRENT_LOCATION_OUTSIDE_ZONE");
    }
  }

  // 12. DYNAMIC RADIUS GATE (single canonical haversine)
  if (details.validGps && hasJobCoords) {
    const distMeters = calculateDistanceMeters(tech.location, booking.location);
    details.distanceMeters = distMeters;
    details.distanceKm = distMeters != null ? Number((distMeters / 1000).toFixed(2)) : null;
    
    const maxRadiusMeters = getEffectiveRadiusMeters(tech);
    details.effectiveRadiusMeters = maxRadiusMeters;
    
    details.radiusPassed = distMeters != null && distMeters <= maxRadiusMeters;
    if (!details.radiusPassed) {
      reasons.push("RADIUS_EXCEEDED");
      reasons.push("TECHNICIAN_OUTSIDE_RADIUS");
    }
  }

  // 13. JOB ALREADY ASSIGNED CHECK
  if (booking.technicianId && String(booking.technicianId) !== String(tech._id)) {
    reasons.push("JOB_ALREADY_ASSIGNED");
  }

  const eligible = reasons.length === 0;

  // Structured logging for traceability
  console.log(`[ELIGIBILITY:${mode}]`, JSON.stringify({
    traceId: shared.traceId || null,
    technicianId: tech._id,
    bookingId: booking._id,
    mode,
    eligible,
    reasons,
    distanceMeters: details.distanceMeters,
    effectiveRadiusMeters: details.effectiveRadiusMeters,
    districtPermission: details.districtPermission,
    currentDistrictMatch: details.currentDistrictMatch,
    zonePermission: details.zonePermission,
    currentZoneMatch: details.currentZoneMatch,
    gpsFresh: details.gpsFresh,
    gpsReason: details.gpsReason,
    gpsAgeSeconds: details.gpsAgeSeconds,
    gpsThresholdSeconds: details.gpsThresholdSeconds,
    online: details.online,
    verified: details.verified,
    trainingComplete: details.trainingComplete,
    kycVerified: details.kycVerified,
    bankVerified: details.bankVerified,
    hasSkill: details.hasSkill,
    serviceAvailable: details.serviceAvailable,
    serviceAvailabilitySource: shared.serviceAvailability ? "precomputed" : "resolved",
  }));

  return { eligible, reasons, details };
};

/**
 * Backward compatibility wrapper for existing callers
 * @deprecated Use evaluateTechnicianEligibility({ mode: "ACCEPT" }) instead
 */
export const checkTechnicianEligibility = async (params) => {
  const result = await evaluateTechnicianEligibility({
    technician: params.technician,
    booking: params.booking,
    mode: "ACCEPT",
  });
  // Transform to old format for compatibility
  return {
    eligible: result.eligible,
    reasons: result.reasons,
    details: {
      ...result.details,
      distanceKm: result.details.distanceKm,
      maxDistanceMeters: MAX_JOB_DISTANCE_METERS,
      configuredRadiusKm: result.details.effectiveRadiusMeters / 1000,
      technicianDistrictId: result.details.technicianDistrictIds[0] || null,
      currentDistrictId: result.details.currentDistrictId,
      jobDistrictId: result.details.jobDistrictId,
    },
  };
};