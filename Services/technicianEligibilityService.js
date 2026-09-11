import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import { resolveOperationalCityFromCoordinates } from "../Utils/technicianMatching.js";
import { resolveServiceAvailability } from "./serviceAvailabilityService.js";
import { haversineMeters } from "../Utils/feasibility.js";

const MAX_JOB_DISTANCE_KM = 10;
const MAX_JOB_DISTANCE_METERS = 10000;
const STALENESS_SECONDS = (() => {
  const raw = Number(process.env.LOCATION_STALENESS_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
})();

/**
 * 🎯 COMPREHENSIVE TECHNICIAN ELIGIBILITY ENGINE
 *
 * Implements the 12-step validation pipeline:
 * 1. Service Availability Check (District / City Scope)
 * 2. Technician Status & Verification (approved, not suspended)
 * 3. Technician Service Skill
 * 4. Online Status
 * 5. GPS Validity & Mocking
 * 6. GPS Freshness (< 90 seconds)
 * 7. Technician District Permission (primaryDistrictId / enabledDistrictIds ONLY — NO CITY ID PERMISSION)
 * 8. Current Physical GPS District Resolution (resolveOperationalCityFromCoordinates)
 * 9. Distance Calculation (Current GPS to Customer Job GPS)
 * 10. 10 KM Radius Gate (<= 10.0 KM)
 * 11. Feasibility / Active Job Lock
 * 12. Final Result & Machine-Readable Reasons
 *
 * @param {Object} params
 * @param {string|Object} params.technician - TechnicianProfile document or ID
 * @param {string|Object} params.serviceId - Service ID
 * @param {number} params.jobLatitude - Customer job latitude
 * @param {number} params.jobLongitude - Customer job longitude
 * @param {string|Object} [params.jobDistrictId=null] - Customer job district ID
 * @param {string|Object} [params.jobCityId=null] - Customer job city ID
 * @param {Object} [params.booking=null] - Optional ServiceBooking document
 * @param {boolean} [params.isMockLocation=false] - Mobile app mock location flag
 * @returns {Promise<Object>} Eligibility breakdown with machine-readable reasons
 */
export const checkTechnicianEligibility = async ({
  technician,
  serviceId,
  jobLatitude,
  jobLongitude,
  jobDistrictId = null,
  jobCityId = null,
  booking = null,
  isMockLocation = false,
}) => {
  const reasons = [];
  const details = {
    serviceAvailable: false,
    districtPermission: false,
    currentDistrictMatch: false,
    online: false,
    verified: false,
    hasSkill: false,
    gpsFresh: false,
    validGps: false,
    distanceKm: null,
    radiusPassed: false,
    technicianDistrictId: null,
    currentDistrictId: null,
    jobDistrictId: null,
  };

  // Extract booking details if booking is passed
  if (booking) {
    serviceId = serviceId || booking.serviceId;
    if (booking.location?.coordinates) {
      jobLongitude = jobLongitude ?? booking.location.coordinates[0];
      jobLatitude = jobLatitude ?? booking.location.coordinates[1];
    }
    jobDistrictId = jobDistrictId || booking.districtId;
    jobCityId = jobCityId || booking.cityZoneId;
  }

  const jobLat = Number(jobLatitude);
  const jobLng = Number(jobLongitude);

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

  // 1. RESOLVE JOB DISTRICT IF NOT PROVIDED
  let targetDistrictId = jobDistrictId ? String(jobDistrictId._id || jobDistrictId) : null;
  if (!targetDistrictId && Number.isFinite(jobLat) && Number.isFinite(jobLng)) {
    const resolvedCity = await resolveOperationalCityFromCoordinates(jobLat, jobLng);
    if (resolvedCity?._id) targetDistrictId = String(resolvedCity._id);
  }
  details.jobDistrictId = targetDistrictId;

  // 2. CHECK SERVICE AVAILABILITY AT JOB LOCATION
  if (serviceId && targetDistrictId) {
    const avail = await resolveServiceAvailability({
      serviceId,
      districtId: targetDistrictId,
      cityId: jobCityId,
    });
    details.serviceAvailable = avail.available;
    if (!avail.available) {
      reasons.push(avail.reason || "SERVICE_NOT_AVAILABLE");
    }
  } else {
    details.serviceAvailable = true; // Fallback if no service/district specified
  }

  // 3. TECHNICIAN WORK STATUS & VERIFICATION
  const isApproved = tech.workStatus === "approved";
  const profileComplete = tech.profileComplete !== false;
  details.verified = isApproved && profileComplete;

  if (tech.workStatus === "suspended") {
    reasons.push("TECHNICIAN_SUSPENDED");
  } else if (!isApproved || !profileComplete) {
    reasons.push("TECHNICIAN_NOT_VERIFIED");
  }

  // 4. TECHNICIAN ONLINE STATUS
  details.online = tech.availability?.isOnline === true;
  if (!details.online) {
    reasons.push("TECHNICIAN_OFFLINE");
  }

  // 5. SERVICE SKILL CHECK
  if (serviceId) {
    const targetServiceIdStr = String(serviceId._id || serviceId);
    const hasSkill = (tech.skills || []).some((s) => {
      const sid = String(s.serviceId?._id || s.serviceId);
      return sid === targetServiceIdStr;
    });
    details.hasSkill = hasSkill;
    if (!hasSkill) {
      reasons.push("SERVICE_SKILL_MISSING");
    }
  }

  // 6. GPS VALIDATION & MOCK LOCATION GUARD
  if (isMockLocation) {
    reasons.push("MOCK_LOCATION");
  }

  const techCoords = tech.location?.coordinates;
  const hasTechCoords =
    Array.isArray(techCoords) &&
    techCoords.length === 2 &&
    Number.isFinite(techCoords[0]) &&
    Number.isFinite(techCoords[1]) &&
    techCoords[1] >= -90 &&
    techCoords[1] <= 90 &&
    techCoords[0] >= -180 &&
    techCoords[0] <= 180;

  details.validGps = hasTechCoords;
  if (!hasTechCoords) {
    reasons.push("MISSING_LOCATION");
  }

  // 7. GPS FRESHNESS CHECK (STALENESS THRESHOLD: 90s)
  if (STALENESS_SECONDS > 0) {
    const cutoff = new Date(Date.now() - STALENESS_SECONDS * 1000);
    const isFresh = tech.locationUpdatedAt && new Date(tech.locationUpdatedAt) >= cutoff;
    details.gpsFresh = Boolean(isFresh);
    if (!isFresh) {
      reasons.push("GPS_STALE");
    }
  } else {
    details.gpsFresh = true;
  }

  // 8. DISTRICT & ZONE PERMISSION CHECK
  const primaryId = tech.primaryDistrictId || tech.primaryCityId;
  const enabledDistricts = [
    ...(tech.enabledDistrictIds || []),
    ...(tech.allowedCityIds || []),
  ].map((d) => String(d._id || d));

  if (primaryId) enabledDistricts.push(String(primaryId._id || primaryId));

  const allowedDistrictIds = Array.from(new Set(enabledDistricts.filter(Boolean)));
  details.technicianDistrictId = allowedDistrictIds[0] || null;

  if (targetDistrictId) {
    const hasDistAccess = allowedDistrictIds.includes(targetDistrictId);
    details.districtPermission = hasDistAccess;
    if (!hasDistAccess) {
      reasons.push("DISTRICT_PERMISSION_DENIED");
    }
  } else {
    details.districtPermission = allowedDistrictIds.length > 0;
  }

  // Check Zone Permission if job specifies a CityZone
  if (jobCityId && Array.isArray(tech.enabledCityZoneIds)) {
    const targetZoneIdStr = String(jobCityId._id || jobCityId);
    const hasZoneAccess = tech.enabledCityZoneIds.some((z) => String(z._id || z) === targetZoneIdStr);
    details.zonePermission = hasZoneAccess;
    if (!hasZoneAccess) {
      reasons.push("ZONE_PERMISSION_DENIED");
    }
  }

  // 9. CURRENT PHYSICAL GPS DISTRICT CHECK
  if (hasTechCoords) {
    const techLat = techCoords[1];
    const techLng = techCoords[0];

    const currentCity = await resolveOperationalCityFromCoordinates(techLat, techLng);
    const currentDistIdStr = currentCity?._id ? String(currentCity._id) : null;
    details.currentDistrictId = currentDistIdStr;

    if (currentDistIdStr) {
      const isCurrentInAllowed = allowedDistrictIds.includes(currentDistIdStr);
      details.currentDistrictMatch = isCurrentInAllowed;
      if (!isCurrentInAllowed) {
        reasons.push("CURRENT_LOCATION_OUTSIDE_DISTRICT");
      }
    }
  }

  // 10. DYNAMIC TECHNICIAN RADIUS GATE (CURRENT GPS TO CUSTOMER JOB GPS)
  if (hasTechCoords && Number.isFinite(jobLat) && Number.isFinite(jobLng)) {
    const distMeters = haversineMeters(
      { latitude: techCoords[1], longitude: techCoords[0] },
      { latitude: jobLat, longitude: jobLng }
    );
    const distKm = Number((distMeters / 1000).toFixed(2));
    details.distanceKm = distKm;

    // Use per-technician configured radius or fallback to 10 KM default
    const maxRadiusKm = Number(tech.serviceRadiusKm) > 0 ? Number(tech.serviceRadiusKm) : MAX_JOB_DISTANCE_KM;
    const maxRadiusMeters = maxRadiusKm * 1000;
    details.configuredRadiusKm = maxRadiusKm;

    const withinRadius = distMeters <= maxRadiusMeters;
    details.radiusPassed = withinRadius;

    if (!withinRadius) {
      reasons.push("TECHNICIAN_OUTSIDE_RADIUS");
    }
  }

  // 11. ACTIVE JOB / ASSIGNMENT LOCK CHECK
  if (booking && booking.technicianId && String(booking.technicianId) !== String(tech._id)) {
    reasons.push("JOB_ALREADY_ASSIGNED");
  }

  const eligible = reasons.length === 0;

  return {
    eligible,
    reasons,
    details,
  };
};
