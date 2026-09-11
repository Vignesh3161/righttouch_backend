import mongoose from "mongoose";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import Service from "../Schemas/Service.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";

/**
 * 🗺 RESOLVE SERVICE AVAILABILITY FOR CUSTOMER LOCATION
 *
 * Implements Rule:
 * 1. Check CITY-level override for matching (serviceId, districtId, cityId).
 *    - If status === "ENABLED" → AVAILABLE (scope: "CITY")
 *    - If status === "DISABLED" → UNAVAILABLE (reason: "CITY_RESTRICTION")
 *
 * 2. If no CITY override exists, check DISTRICT-level configuration (serviceId, districtId, cityId: null).
 *    - If status === "ENABLED" → AVAILABLE (scope: "DISTRICT")
 *    - If status === "DISABLED" → UNAVAILABLE (reason: "SERVICE_DISABLED")
 *
 * 3. If no explicit ServiceAvailability document exists:
 *    - Check base Service.isActive flag. If Service.isActive === true and no district availability is restricted,
 *      default to AVAILABLE (scope: "DISTRICT"). If restrictions exist, UNAVAILABLE (reason: "SERVICE_NOT_AVAILABLE").
 *
 * @param {Object} params
 * @param {string|ObjectId} params.serviceId
 * @param {string|ObjectId} params.districtId
 * @param {string|ObjectId} [params.cityId=null]
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

  const service = await Service.findById(serviceId).select("isActive").lean();
  if (!service || !service.isActive) {
    return {
      available: false,
      scope: null,
      districtId: districtId || null,
      cityZoneId: cityZoneId || cityId || null,
      status: "DISABLED",
      reason: "SERVICE_DISABLED",
    };
  }

  if (!districtId) {
    return {
      available: true,
      scope: "DEFAULT",
      districtId: null,
      cityZoneId: null,
      status: "ENABLED",
      reason: "NO_DISTRICT_CONTEXT",
    };
  }

  const districtObjId = new mongoose.Types.ObjectId(districtId);
  const targetZoneId = cityZoneId || cityId;
  const zoneObjId = targetZoneId ? new mongoose.Types.ObjectId(targetZoneId) : null;
  const cityObjId = zoneObjId;

  // Look up pricing multiplier from ZoneServiceMapping if zone is specified
  let pricingMultiplier = 1.0;
  if (zoneObjId) {
    const mapping = await ZoneServiceMapping.findOne({
      zoneId: zoneObjId,
      serviceId,
      active: true,
    }).lean();
    if (mapping && mapping.pricingMultiplier) {
      pricingMultiplier = Number(mapping.pricingMultiplier) || 1.0;
    }
  }

  // 1. ZONE / SUB-ZONE LEVEL OVERRIDE CHECK (Priority 1: ZONE > DISTRICT)
  if (zoneObjId) {
    const zoneOverride = await ServiceAvailability.findOne({
      serviceId,
      districtId: districtObjId,
      $or: [{ cityZoneId: zoneObjId }, { cityId: zoneObjId }],
      scope: { $in: ["ZONE", "CITY"] },
    }).lean();

    if (zoneOverride) {
      const isCityScope = zoneOverride.scope === "CITY";
      if (zoneOverride.status === "ENABLED") {
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
      } else {
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
      }
    }
  }

  // 2. DISTRICT LEVEL DEFAULT CHECK
  const districtDefault = await ServiceAvailability.findOne({
    serviceId,
    districtId: districtObjId,
    cityZoneId: null,
    cityId: null,
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
