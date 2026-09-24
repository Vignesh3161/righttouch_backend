import mongoose from "mongoose";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import Service from "../Schemas/Service.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";

/**
 * 🗺 RESOLVE SERVICE AVAILABILITY FOR CUSTOMER LOCATION
 *
 * Required RightTouch rule (strict):
 *   Service.isActive + Zone.active + ZoneServiceMapping.active = available.
 *   When a zone context exists, an active mapping is MANDATORY — "no mapping"
 *   never means available. New zones are created with every service DISABLED,
 *   admin explicitly enables required services.
 *   A deactivated zone (active=false) returns ZONE_INACTIVE and must BLOCK
 *   checkout/booking — callers must resolve the zone with includeInactive:true
 *   so the inactive polygon is detected instead of falling back to district.
 *
 * Precedence inside a zone: ZONE/CITY DISABLED override > mapping gate >
 *   ZONE/CITY ENABLED override > DISTRICT default.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.serviceId
 * @param {string|ObjectId} params.districtId
 * @param {string|ObjectId} [params.cityId=null] (legacy alias of zone)
 * @param {string|ObjectId} [params.cityZoneId=null]
 * @returns {Promise<Object>} { available, scope, districtId, cityId, status, reason }
 */
export const resolveServiceAvailability = async ({
  serviceId,
  districtId,
  cityId = null,
  cityZoneId = null,
}) => {
  if (!serviceId) {
    return {
      available: false,
      scope: null,
      districtId: null,
      cityZoneId: null,
      status: "DISABLED",
      reason: "MISSING_SERVICE_ID",
    };
  }

  const service = await Service.findById(serviceId).select("isActive zoneRestricted serviceName").lean();
  if (!service || !service.isActive) {
    return {
      available: false,
      scope: null,
      districtId: districtId || null,
      cityZoneId: cityZoneId || cityId || null,
      status: "DISABLED",
      reason: "SERVICE_INACTIVE",
    };
  }

  let resolvedDistrictId = districtId;
  const targetZoneId = cityZoneId || cityId;

  if (!resolvedDistrictId && targetZoneId) {
    const zDoc = await CityZone.findById(targetZoneId).select("operationalCityId").lean();
    if (zDoc?.operationalCityId) {
      resolvedDistrictId = zDoc.operationalCityId;
    }
  }

  if (!resolvedDistrictId) {
    return {
      available: true,
      scope: "DEFAULT",
      districtId: null,
      cityZoneId: targetZoneId ? String(targetZoneId) : null,
      status: "ENABLED",
      reason: "NO_DISTRICT_CONTEXT",
    };
  }

  const districtObjId = new mongoose.Types.ObjectId(resolvedDistrictId);
  const zoneObjId = targetZoneId ? new mongoose.Types.ObjectId(targetZoneId) : null;
  const cityObjId = zoneObjId;

  // 0. DISTRICT OPERATIONAL STATUS CHECK (District must be active and jobs enabled)
  const districtDoc = await OperationalCity.findById(districtObjId)
    .select("active isJobEnabled")
    .lean();
  if (districtDoc && (districtDoc.active === false || districtDoc.isJobEnabled === false)) {
    return {
      available: false,
      scope: "DISTRICT",
      districtId: String(districtObjId),
      cityZoneId: zoneObjId ? String(zoneObjId) : null,
      cityId: cityObjId ? String(cityObjId) : null,
      status: "DISABLED",
      reason: "DISTRICT_DISABLED",
    };
  }

  // 1. ZONE-LEVEL VALIDATION & OVERRIDE CHECK (Priority 1: ZONE > DISTRICT)
  let pricingMultiplier = 1.0;
  if (zoneObjId) {
    // 1A0. Zone itself must exist and be active — inactive zone = unavailable
    const zoneDoc = await CityZone.findById(zoneObjId).select("active").lean();
    if (zoneDoc && zoneDoc.active === false) {
      return {
        available: false,
        scope: "ZONE",
        districtId: String(districtObjId),
        cityZoneId: String(zoneObjId),
        cityId: String(zoneObjId),
        pricingMultiplier: 1.0,
        status: "DISABLED",
        reason: "ZONE_INACTIVE",
      };
    }

    // 1A. ZoneServiceMapping gate — MANDATORY when zone context exists
    // (required architecture: no mapping = DISABLED, new zones default DISABLED).
    // zoneRestricted flag is retained only for the customer listing pre-filter;
    // the booking/checkout gate does not bypass on it.
    {
      const mapping = await ZoneServiceMapping.findOne({
        zoneId: zoneObjId,
        serviceId,
        active: true,
      }).lean();

      if (!mapping) {
        return {
          available: false,
          scope: "ZONE",
          districtId: String(districtObjId),
          cityZoneId: String(zoneObjId),
          cityId: String(zoneObjId),
          pricingMultiplier: 1.0,
          status: "DISABLED",
          reason: "ZONE_SERVICE_NOT_MAPPED",
        };
      }

      if (mapping.pricingMultiplier) {
        pricingMultiplier = Number(mapping.pricingMultiplier) || 1.0;
      }
    }

    // 1B. Zone-Level ServiceAvailability Override (supports legacy cityId docs).
    const zoneOverride = await ServiceAvailability.findOne({
      serviceId,
      districtId: districtObjId,
      $or: [{ cityZoneId: zoneObjId }, { cityId: zoneObjId }],
      scope: { $in: ["ZONE", "CITY"] },
    }).lean();

    if (zoneOverride) {
      const isCityScope = zoneOverride.scope === "CITY";
      if (zoneOverride.status === "DISABLED") {
        // ZONE DISABLED strictly overrides District ENABLED!
        return {
          available: false,
          scope: zoneOverride.scope,
          districtId: String(districtObjId),
          cityZoneId: String(zoneObjId),
          cityId: String(zoneObjId),
          pricingMultiplier,
          status: "DISABLED",
          reason: isCityScope ? "CITY_RESTRICTION" : "ZONE_RESTRICTION",
        };
      } else if (zoneOverride.status === "ENABLED") {
        return {
          available: true,
          scope: zoneOverride.scope,
          districtId: String(districtObjId),
          cityZoneId: String(zoneObjId),
          cityId: String(zoneObjId),
          pricingMultiplier,
          status: "ENABLED",
          reason: isCityScope ? "CITY_ENABLED" : "ZONE_ENABLED",
        };
      }
    }
  }

  // 2. DISTRICT LEVEL DEFAULT CHECK (Priority 2: Evaluated only when no zone override exists)
  const districtDefault = await ServiceAvailability.findOne({
    serviceId,
    districtId: districtObjId,
    cityZoneId: null,
    scope: "DISTRICT",
  }).lean();

  if (districtDefault) {
    if (districtDefault.status === "ENABLED") {
      return {
        available: true,
        scope: "DISTRICT",
        districtId: String(districtObjId),
        cityId: cityObjId ? String(cityObjId) : null,
        pricingMultiplier,
        status: "ENABLED",
        reason: "DISTRICT_ENABLED",
      };
    } else {
      return {
        available: false,
        scope: "DISTRICT",
        districtId: String(districtObjId),
        cityId: cityObjId ? String(cityObjId) : null,
        pricingMultiplier,
        status: "DISABLED",
        reason: "SERVICE_DISABLED",
      };
    }
  }

  // 3. FALLBACK: Check if ANY ServiceAvailability exists for this district.
  // If rules exist for this district but not for this service, it is unavailable in this district.
  const districtRulesExist = await ServiceAvailability.exists({
    districtId: districtObjId,
  });

  if (districtRulesExist) {
    return {
      available: false,
      scope: "DISTRICT",
      districtId: String(districtObjId),
      cityId: cityObjId ? String(cityObjId) : null,
      pricingMultiplier,
      status: "DISABLED",
      reason: "SERVICE_NOT_AVAILABLE",
    };
  }

  // If no district rules are configured at all, fallback to general service status
  return {
    available: true,
    scope: "DISTRICT",
    districtId: String(districtObjId),
    cityId: cityObjId ? String(cityObjId) : null,
    pricingMultiplier,
    status: "ENABLED",
    reason: "DEFAULT_ENABLED",
  };
};

/**
 * Filter an array of services for a given customer district & city.
 */
export const filterAvailableServicesForCustomer = async ({
  services,
  districtId,
  cityId = null,
}) => {
  if (!Array.isArray(services) || services.length === 0) return [];
  if (!districtId) return services;

  const results = [];
  for (const s of services) {
    const res = await resolveServiceAvailability({
      serviceId: s._id || s,
      districtId,
      cityId,
    });
    if (res.available) {
      results.push({
        ...(typeof s.toObject === "function" ? s.toObject() : s),
        availabilityMetadata: {
          available: true,
          scope: res.scope,
          districtId: res.districtId,
          cityId: res.cityId,
        },
      });
    }
  }

  return results;
};
