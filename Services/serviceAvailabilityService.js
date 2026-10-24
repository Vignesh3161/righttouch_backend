import mongoose from "mongoose";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import Service from "../Schemas/Service.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";

const keyOf = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && value._id !== undefined) return String(value._id);
  return String(value);
};

const asObjectId = (value) => {
  try {
    return new mongoose.Types.ObjectId(value);
  } catch {
    return null;
  }
};

const disabledResult = (base, reason, overrides = {}) => ({
  ...base,
  available: false,
  status: "DISABLED",
  reason,
  ...overrides,
});

/**
 * Pure in-memory evaluator. Callers preload the relevant documents so the
 * admin matrix and the runtime resolver can never drift apart.
 *
 * Strict rule: an active ZoneServiceMapping is mandatory whenever a zone is
 * in context. `Service.zoneRestricted` is metadata only and never bypasses it.
 */
export const evaluateZoneAvailability = ({
  service,
  district,
  zone = null,
  mapping = null,
  canonicalOverride = null,
  cityOverride = null,
  districtDefault = null,
}) => {
  const serviceKey = keyOf(service);
  const districtKey = keyOf(district);
  const zoneKey = keyOf(zone);
  const base = {
    serviceId: serviceKey,
    districtId: districtKey,
    cityZoneId: zoneKey,
    cityId: zoneKey,
    pricingMultiplier: 1.0,
    mappingExists: Boolean(mapping),
    mappingActive: mapping?.active === true,
    overrideScope: null,
    overrideStatus: null,
    districtDefaultStatus: districtDefault?.status || null,
  };

  if (!service || !service.isActive) {
    return disabledResult(base, "SERVICE_INACTIVE", { scope: null });
  }
  if (!district) {
    return disabledResult(base, "DISTRICT_NOT_FOUND", { scope: "DISTRICT" });
  }
  if (district.active === false || district.isJobEnabled === false) {
    return disabledResult(base, "DISTRICT_DISABLED", { scope: "DISTRICT" });
  }

  if (!zone) {
    if (districtDefault) {
      return {
        ...base,
        available: districtDefault.status === "ENABLED",
        scope: "DISTRICT",
        status: districtDefault.status === "ENABLED" ? "ENABLED" : "DISABLED",
        reason:
          districtDefault.status === "ENABLED"
            ? "DISTRICT_ENABLED"
            : "SERVICE_DISABLED",
      };
    }
    return {
      ...base,
      available: true,
      scope: "DISTRICT",
      status: "ENABLED",
      reason: "DEFAULT_ENABLED",
    };
  }

  if (!zone.operationalCityId) {
    return disabledResult(base, "ZONE_NOT_FOUND", { scope: "ZONE" });
  }
  if (String(zone.operationalCityId) !== String(district._id)) {
    return disabledResult(base, "ZONE_DISTRICT_MISMATCH", {
      scope: "ZONE",
      cityZoneId: zoneKey,
      cityId: zoneKey,
    });
  }
  if (zone.active === false) {
    return disabledResult(base, "ZONE_INACTIVE", { scope: "ZONE" });
  }

  if (!mapping || mapping.active !== true) {
    return disabledResult(base, "ZONE_SERVICE_NOT_MAPPED", { scope: "ZONE" });
  }

  if (mapping.pricingMultiplier) {
    base.pricingMultiplier = Number(mapping.pricingMultiplier) || 1.0;
  }

  const override = canonicalOverride || cityOverride || null;
  if (override) {
    const isCityScope = override.scope === "CITY";
    if (override.status === "DISABLED") {
      return {
        ...base,
        available: false,
        scope: override.scope,
        status: "DISABLED",
        reason: isCityScope ? "CITY_RESTRICTION" : "ZONE_RESTRICTION",
        overrideScope: override.scope,
        overrideStatus: override.status,
      };
    }
    if (override.status === "ENABLED") {
      return {
        ...base,
        available: true,
        scope: override.scope,
        status: "ENABLED",
        reason: isCityScope ? "CITY_ENABLED" : "ZONE_ENABLED",
        overrideScope: override.scope,
        overrideStatus: override.status,
      };
    }
  }

  if (districtDefault) {
    return {
      ...base,
      available: districtDefault.status === "ENABLED",
      scope: "DISTRICT",
      status: districtDefault.status === "ENABLED" ? "ENABLED" : "DISABLED",
      reason:
        districtDefault.status === "ENABLED"
          ? "DISTRICT_ENABLED"
          : "SERVICE_DISABLED",
    };
  }

  // Strict per-zone mapping is the grant. No blanket "district has rules so
  // this service is off" fallback: without it, activating a mapping alone was
  // never enough to make a service bookable.
  return {
    ...base,
    available: true,
    scope: "ZONE",
    status: "ENABLED",
    reason: "MAPPING_ENABLED",
  };
};

/**
 * Batch-load everything the matrix/detail screens need and expose an
 * evaluator that uses the exact same in-memory rules as the resolver.
 */
export const getAvailabilitySnapshot = async ({
  serviceIds = null,
  districtIds = null,
  zoneIds = null,
} = {}) => {
  const serviceFilter = serviceIds ? { _id: { $in: serviceIds.map(asObjectId).filter(Boolean) } } : {};
  const districtFilter = districtIds
    ? { _id: { $in: districtIds.map(asObjectId).filter(Boolean) } }
    : {};
  const zoneFilter = zoneIds
    ? { _id: { $in: zoneIds.map(asObjectId).filter(Boolean) } }
    : {};
  if (districtIds) {
    zoneFilter.operationalCityId = { $in: districtIds.map(asObjectId).filter(Boolean) };
  }

  const [services, districts, zones, mappings, availabilities] = await Promise.all([
    Service.find(serviceFilter).select("isActive zoneRestricted serviceName").lean(),
    OperationalCity.find(districtFilter).select("active isJobEnabled name code").lean(),
    CityZone.find(zoneFilter).select("active operationalCityId name zoneCode").lean(),
    ZoneServiceMapping.find({
      ...(zoneIds ? { zoneId: { $in: zoneIds.map(asObjectId).filter(Boolean) } } : {}),
      ...(serviceIds ? { serviceId: { $in: serviceIds.map(asObjectId).filter(Boolean) } } : {}),
    })
      .select("zoneId serviceId active pricingMultiplier")
      .lean(),
    ServiceAvailability.find({
      ...(serviceIds ? { serviceId: { $in: serviceIds.map(asObjectId).filter(Boolean) } } : {}),
      ...(districtIds ? { districtId: { $in: districtIds.map(asObjectId).filter(Boolean) } } : {}),
    })
      .sort({ updatedAt: -1 })
      .lean(),
  ]);

  const servicesById = new Map(services.map((s) => [String(s._id), s]));
  const districtsById = new Map(districts.map((d) => [String(d._id), d]));
  const zonesById = new Map(zones.map((z) => [String(z._id), z]));
  const mappingsByKey = new Map();
  const canonicalByKey = new Map();
  const cityByKey = new Map();
  const districtDefaultByKey = new Map();

  mappings.forEach((mapping) => {
    const key = `${String(mapping.serviceId)}_${String(mapping.zoneId)}`;
    if (!mappingsByKey.has(key)) mappingsByKey.set(key, mapping);
  });

  availabilities.forEach((row) => {
    if (row.scope === "ZONE" && row.cityZoneId) {
      const key = `${String(row.serviceId)}_${String(row.cityZoneId)}`;
      if (!canonicalByKey.has(key)) canonicalByKey.set(key, row);
    } else if (row.scope === "CITY") {
      const zoneKey = row.cityId || row.cityZoneId;
      if (zoneKey) {
        const key = `${String(row.serviceId)}_${String(zoneKey)}`;
        if (!cityByKey.has(key)) cityByKey.set(key, row);
      }
    } else if (row.scope === "DISTRICT") {
      const key = `${String(row.serviceId)}_${String(row.districtId)}`;
      if (!districtDefaultByKey.has(key)) districtDefaultByKey.set(key, row);
    }
  });

  const evaluate = (serviceId, districtId, zoneId = null) => {
    const serviceKey = keyOf(serviceId);
    const districtKey = keyOf(districtId);
    const zoneKey = keyOf(zoneId);
    const service = servicesById.get(serviceKey) || null;
    const district = districtsById.get(districtKey) || null;
    const zone = zoneKey ? zonesById.get(zoneKey) || null : null;
    const mapping = zoneKey
      ? mappingsByKey.get(`${serviceKey}_${zoneKey}`) || null
      : null;
    const canonicalOverride = zoneKey
      ? canonicalByKey.get(`${serviceKey}_${zoneKey}`) || null
      : null;
    const cityOverride = zoneKey
      ? cityByKey.get(`${serviceKey}_${zoneKey}`) || null
      : null;
    const districtDefault = districtKey
      ? districtDefaultByKey.get(`${serviceKey}_${districtKey}`) || null
      : null;

    return evaluateZoneAvailability({
      service,
      district,
      zone,
      mapping,
      canonicalOverride,
      cityOverride,
      districtDefault,
    });
  };

  return {
    services,
    districts,
    zones,
    servicesById,
    districtsById,
    zonesById,
    evaluate,
  };
};

/**
 * 🗺 RESOLVE SERVICE AVAILABILITY FOR CUSTOMER LOCATION
 *
 * Required RightTouch rule (strict):
 *   Service.isActive + District active/jobs-enabled + Zone.active +
 *   ZoneServiceMapping.active = available. New zones are created with every
 *   service DISABLED; admin explicitly enables required services.
 *
 * Precedence inside a zone: mapping gate > canonical ZONE override >
 *   legacy CITY override > DISTRICT default > mapping grant.
 *
 * B-10: canonical ZONE rows (cityZoneId) govern; legacy CITY rows (cityId)
 * apply only absent a canonical row. B-11: fail closed — missing district
 * context, malformed identifiers, or an unknown district never authorize.
 */
export const resolveServiceAvailability = async ({
  serviceId,
  districtId,
  cityId = null,
  cityZoneId = null,
}) => {
  const serviceKey = keyOf(serviceId);
  const providedDistrictKey = keyOf(districtId);
  const targetZoneKey = keyOf(cityZoneId || cityId);

  if (!serviceKey) {
    return disabledResult(
      {
        serviceId: null,
        districtId: null,
        cityZoneId: null,
        cityId: null,
        pricingMultiplier: 1.0,
        mappingExists: false,
        mappingActive: false,
        overrideScope: null,
        overrideStatus: null,
        districtDefaultStatus: null,
      },
      "MISSING_SERVICE_ID",
      { scope: null }
    );
  }

  if (!mongoose.Types.ObjectId.isValid(serviceKey)) {
    return disabledResult(
      {
        serviceId: serviceKey,
        districtId: providedDistrictKey,
        cityZoneId: null,
        cityId: null,
        pricingMultiplier: 1.0,
        mappingExists: false,
        mappingActive: false,
        overrideScope: null,
        overrideStatus: null,
        districtDefaultStatus: null,
      },
      "INVALID_SERVICE",
      { scope: null }
    );
  }

  if (targetZoneKey && !mongoose.Types.ObjectId.isValid(targetZoneKey)) {
    return disabledResult(
      {
        serviceId: serviceKey,
        districtId: providedDistrictKey,
        cityZoneId: null,
        cityId: null,
        pricingMultiplier: 1.0,
        mappingExists: false,
        mappingActive: false,
        overrideScope: null,
        overrideStatus: null,
        districtDefaultStatus: null,
      },
      "INVALID_ZONE",
      { scope: "ZONE" }
    );
  }

  const [service, zoneDoc] = await Promise.all([
    Service.findById(serviceKey).select("isActive zoneRestricted serviceName").lean(),
    targetZoneKey
      ? CityZone.findById(targetZoneKey).select("active operationalCityId name zoneCode").lean()
      : Promise.resolve(null),
  ]);

  let resolvedDistrictKey = providedDistrictKey;
  if (!resolvedDistrictKey && zoneDoc?.operationalCityId) {
    resolvedDistrictKey = String(zoneDoc.operationalCityId);
  }

  const base = {
    serviceId: serviceKey,
    districtId: resolvedDistrictKey,
    cityZoneId: targetZoneKey,
    cityId: targetZoneKey,
    pricingMultiplier: 1.0,
    mappingExists: false,
    mappingActive: false,
    overrideScope: null,
    overrideStatus: null,
    districtDefaultStatus: null,
  };

  if (!service || !service.isActive) {
    return disabledResult(base, "SERVICE_INACTIVE", { scope: null });
  }

  if (!resolvedDistrictKey) {
    return disabledResult(base, "DISTRICT_REQUIRED", { scope: "DISTRICT" });
  }

  const districtObjId = asObjectId(resolvedDistrictKey);
  if (!districtObjId) {
    return disabledResult(base, "INVALID_DISTRICT", { scope: "DISTRICT" });
  }

  if (targetZoneKey && !zoneDoc) {
    return disabledResult(base, "ZONE_NOT_FOUND", { scope: "ZONE" });
  }

  const districtDoc = await OperationalCity.findById(districtObjId)
    .select("active isJobEnabled name code")
    .lean();

  if (!districtDoc) {
    return disabledResult(base, "DISTRICT_NOT_FOUND", { scope: "DISTRICT" });
  }
  if (districtDoc.active === false || districtDoc.isJobEnabled === false) {
    return disabledResult(base, "DISTRICT_DISABLED", { scope: "DISTRICT" });
  }

  let mapping = null;
  let canonicalOverride = null;
  let cityOverride = null;

  if (zoneDoc) {
    const mappingQuery = ZoneServiceMapping.findOne({
      zoneId: zoneDoc._id,
      serviceId: serviceKey,
    });
    const canonicalQuery = ServiceAvailability.findOne({
      serviceId: serviceKey,
      districtId: districtObjId,
      cityZoneId: zoneDoc._id,
      scope: "ZONE",
    });
    const cityQuery = ServiceAvailability.findOne({
      serviceId: serviceKey,
      districtId: districtObjId,
      scope: "CITY",
      $or: [{ cityId: zoneDoc._id }, { cityZoneId: zoneDoc._id }],
    });

    [mapping, canonicalOverride, cityOverride] = await Promise.all([
      mappingQuery.lean(),
      canonicalQuery.lean(),
      cityQuery.lean(),
    ]);

    if (canonicalOverride && cityOverride) {
      if (String(cityOverride.status) !== String(canonicalOverride.status)) {
        console.warn(
          `[availability] conflicting legacy CITY row ${cityOverride._id} shadows canonical ZONE row ${canonicalOverride._id} (service ${serviceKey}, zone ${zoneDoc._id}); canonical governs`
        );
      }
    }
  }

  const districtDefault = await ServiceAvailability.findOne({
    serviceId: serviceKey,
    districtId: districtObjId,
    cityZoneId: null,
    scope: "DISTRICT",
  }).lean();

  return evaluateZoneAvailability({
    service,
    district: districtDoc,
    zone: zoneDoc,
    mapping,
    canonicalOverride,
    cityOverride,
    districtDefault,
  });
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
