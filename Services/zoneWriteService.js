import mongoose from "mongoose";
import CityZone from "../Schemas/CityZone.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import PolygonVersion from "../Schemas/PolygonVersion.js";
import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import {
  validateAndSanitizePolygon,
  validateZoneInsideDistrict,
  checkZoneOverlap,
} from "../Utils/geoValidation.js";
import { invalidateOperationalPolygonCache } from "../Utils/technicianMatching.js";

export const ZONE_SERVICE_MODES = ["INHERIT", "ENABLE_ALL", "DISABLE_ALL"];

const ACTIVE_BOOKING_STATUSES = [
  "pending",
  "broadcasted",
  "accepted",
  "on_the_way",
  "reached",
  "in_progress",
];

const lifecycleError = (code, message, statusCode = 400, details = null) => {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (details) err.details = details;
  return err;
};

export const normalizeZoneServiceMode = (value) => {
  const mode = String(value || "").trim().toUpperCase();
  return ZONE_SERVICE_MODES.includes(mode) ? mode : "INHERIT";
};

/**
 * Canonical district/zone write invariants (B-05).
 *
 * Both the standard CRUD controllers (operationalCity/cityZone) and the
 * geofence controller funnel geometry validation, placement checks, seeding,
 * versioning and cache invalidation through these helpers so the two route
 * families can no longer diverge. Endpoint paths and response contracts are
 * preserved by the callers.
 */

export const sanitizePolygon = (polygon) => validateAndSanitizePolygon(polygon);

/** Next PolygonVersion number for an entity (append-only history). */
export const nextPolygonVersion = async (entityType, entityId, session = null) => {
  const q = PolygonVersion.countDocuments({ entityType, entityId });
  const count = session ? await q.session(session) : await q;
  return count + 1;
};

export const recordPolygonVersion = async (
  { entityType, entityId, polygon, changedBy, changeReason },
  session = null
) => {
  const version = await nextPolygonVersion(entityType, entityId, session);
  const doc = {
    entityType,
    entityId,
    version,
    polygon,
    changedBy,
    changeReason,
  };
  if (session) {
    const [created] = await PolygonVersion.create([doc], { session });
    return created;
  }
  return PolygonVersion.create(doc);
};

/**
 * Containment (zone inside parent district) + overlap (vs other ACTIVE zones
 * in the district) placement checks. Returns { ok:true } or
 * { ok:false, code, message } for a 400/409 response.
 */
export const assertZonePlacement = async ({ sanitizedPolygon, districtId, excludeZoneId = null }) => {
  const district = await OperationalCity.findById(districtId).lean();
  if (!district) return { ok: false, status: 404, code: "DISTRICT_NOT_FOUND", message: "Parent district not found" };

  let containment = null;
  if (district.polygon) {
    containment = validateZoneInsideDistrict(sanitizedPolygon, district.polygon);
    if (!containment.valid && !checkZoneOverlap(sanitizedPolygon, district.polygon)) {
      return {
        ok: false,
        status: 400,
        code: "ZONE_OUTSIDE_PARENT_DISTRICT",
        message: "Sub-zone polygon does not overlap the parent Operational District boundary.",
      };
    }
  }

  // Reservation policy: geography is checked against ALL zones in the
  // district (active and inactive) so a retired zone still reserves its
  // area; reactivating or rebuilding over it would otherwise collide.
  const existingZones = await CityZone.find({ operationalCityId: districtId }).lean();
  for (const ez of existingZones) {
    if (excludeZoneId && String(ez._id) === String(excludeZoneId)) continue;
    if (ez.polygon && checkZoneOverlap(sanitizedPolygon, ez.polygon)) {
      return {
        ok: false,
        status: 409,
        code: "ZONE_OVERLAP_DETECTED",
        message: `Zone polygon overlaps geographically with existing ${ez.active === false ? "inactive " : ""}zone "${ez.name || "Zone"}" in the same district.`,
      };
    }
  }
  return {
    ok: true,
    district,
    containment: {
      fullyContained: containment ? containment.valid : true,
      reason: containment?.valid ? null : containment?.reason || null,
    },
  };
};

/**
 * Reject overlapping active districts. District polygons are the first
 * resolution step, so overlap makes the same point resolve to different
 * parents depending on query order.
 */
export const assertDistrictPlacement = async ({
  sanitizedPolygon,
  excludeDistrictId = null,
}) => {
  const filter = { active: { $ne: false } };
  if (excludeDistrictId) filter._id = { $ne: excludeDistrictId };
  const existingDistricts = await OperationalCity.find(filter).select("_id name polygon").lean();
  for (const district of existingDistricts) {
    if (!district.polygon) continue;
    if (checkZoneOverlap(sanitizedPolygon, district.polygon)) {
      return {
        ok: false,
        status: 409,
        code: "DISTRICT_OVERLAP_DETECTED",
        message: `District polygon overlaps geographically with existing district "${district.name || "District"}".`,
      };
    }
  }
  return { ok: true };
};

/**
 * When a district polygon shrinks/moves, every child zone must still fit
 * inside the new boundary. Otherwise resolution and dispatch would disagree.
 */
export const assertDistrictContainsZones = async ({ districtId, sanitizedPolygon }) => {
  const zones = await CityZone.find({ operationalCityId: districtId })
    .select("_id name polygon")
    .lean();
  for (const zone of zones) {
    if (!zone.polygon) continue;
    const containment = validateZoneInsideDistrict(zone.polygon, sanitizedPolygon);
    if (!containment.valid) {
      return {
        ok: false,
        status: 400,
        code: "ZONE_OUTSIDE_NEW_DISTRICT_BOUNDARY",
        message: `Zone "${zone.name || "Zone"}" would fall outside the updated district boundary: ${containment.reason}`,
      };
    }
  }
  return { ok: true };
};

const loadDistrictAvailabilityMap = async (districtId, session = null) => {
  let query = ServiceAvailability.find({
    districtId,
    scope: "DISTRICT",
    cityZoneId: null,
  }).select("serviceId status");
  if (session) query = query.session(session);
  const rows = await query.lean();
  return new Map(rows.map((row) => [String(row.serviceId), row.status]));
};

const seedEnabledForMode = (serviceId, mode, districtAvailability) => {
  if (mode === "ENABLE_ALL") return true;
  if (mode === "DISABLE_ALL") return false;
  // INHERIT: explicit district DISABLED wins; explicit ENABLED or no rule
  // means enabled (matches the resolver's DEFAULT_ENABLED district fallback).
  return districtAvailability.get(String(serviceId)) !== "DISABLED";
};

/**
 * Seed every active service into a newly created zone.
 *
 * Product policy is configurable per zone:
 * - INHERIT (default): copy the parent district's DISTRICT-level rule.
 * - ENABLE_ALL: all active services are enabled.
 * - DISABLE_ALL: all active services start disabled.
 */
export const seedZoneServices = async ({
  zone,
  serviceMode = "INHERIT",
  actorId = null,
  session = null,
}) => {
  const mode = normalizeZoneServiceMode(serviceMode);
  let servicesQuery = Service.find({ isActive: true }).select("_id");
  if (session) servicesQuery = servicesQuery.session(session);
  const activeServices = await servicesQuery.lean();
  if (!activeServices.length) {
    return { total: 0, enabled: 0, disabled: 0, mode };
  }

  const districtAvailability = await loadDistrictAvailabilityMap(zone.operationalCityId, session);
  const enabledServices = activeServices.filter((service) =>
    seedEnabledForMode(service._id, mode, districtAvailability)
  );
  const enabledIds = new Set(enabledServices.map((service) => String(service._id)));

  const mapOps = activeServices.map((service) => ({
    updateOne: {
      filter: { zoneId: zone._id, serviceId: service._id },
      update: {
        $setOnInsert: {
          zoneId: zone._id,
          serviceId: service._id,
          approvedBy: actorId,
          approvedAt: new Date(),
        },
        $set: { active: enabledIds.has(String(service._id)) },
      },
      upsert: true,
    },
  }));
  if (mapOps.length) {
    await ZoneServiceMapping.bulkWrite(mapOps, {
      ordered: false,
      ...(session ? { session } : {}),
    });
  }

  const availOps = activeServices.map((service) => ({
    updateOne: {
      filter: {
        serviceId: service._id,
        districtId: zone.operationalCityId,
        cityZoneId: zone._id,
        scope: "ZONE",
      },
      update: {
        $set: {
          serviceId: service._id,
          districtId: zone.operationalCityId,
          cityZoneId: zone._id,
          cityId: zone._id,
          scope: "ZONE",
          status: enabledIds.has(String(service._id)) ? "ENABLED" : "DISABLED",
          updatedBy: actorId,
        },
      },
      upsert: true,
    },
  }));
  if (availOps.length) {
    await ServiceAvailability.bulkWrite(availOps, {
      ordered: false,
      ...(session ? { session } : {}),
    });
  }

  return {
    total: activeServices.length,
    enabled: enabledIds.size,
    disabled: activeServices.length - enabledIds.size,
    mode,
  };
};

/** Backward-compatible wrapper for callers that still want strict seeding. */
export const seedZoneDisabledServices = async ({ zone, actorId = null, session = null }) => {
  const result = await seedZoneServices({
    zone,
    serviceMode: "DISABLE_ALL",
    actorId,
    session,
  });
  return result.total;
};

/**
 * Canonical per-zone availability write. Updates the mandatory mapping and
 * the canonical ZONE mirror together, inside a transaction unless the caller
 * already supplied a session.
 */
export const setZoneServiceAvailability = async ({
  serviceId,
  districtId,
  cityZoneId,
  enabled,
  actorId = null,
  session = null,
}) => {
  const apply = async (txnSession) => {
    let zoneQuery = CityZone.findById(cityZoneId).select("operationalCityId active name");
    if (txnSession) zoneQuery = zoneQuery.session(txnSession);
    const zone = await zoneQuery.lean();
    if (!zone) {
      throw lifecycleError("ZONE_NOT_FOUND", "City zone not found", 404);
    }
    if (String(zone.operationalCityId) !== String(districtId)) {
      throw lifecycleError(
        "ZONE_DISTRICT_MISMATCH",
        "cityZoneId must belong to the supplied districtId",
        400
      );
    }

    await ZoneServiceMapping.updateOne(
      { zoneId: cityZoneId, serviceId },
      {
        $set: { active: Boolean(enabled) },
        $setOnInsert: {
          zoneId: cityZoneId,
          serviceId,
          approvedBy: actorId,
          approvedAt: new Date(),
        },
      },
      { upsert: true, ...(txnSession ? { session: txnSession } : {}) }
    );

    const config = await ServiceAvailability.findOneAndUpdate(
      {
        serviceId,
        districtId,
        cityZoneId,
        scope: "ZONE",
      },
      {
        $set: {
          serviceId,
          districtId,
          cityZoneId,
          cityId: cityZoneId,
          scope: "ZONE",
          status: enabled ? "ENABLED" : "DISABLED",
          updatedBy: actorId,
        },
      },
      { upsert: true, new: true, ...(txnSession ? { session: txnSession } : {}) }
    );

    return { zone, config, enabled: Boolean(enabled) };
  };

  if (session) return apply(session);
  const { result } = await withZoneWriteTransaction(apply);
  return result;
};

/** Bulk form used by matrix/bulk admin actions. */
export const setZoneServiceAvailabilityBulk = async ({
  serviceId,
  districtId,
  cityZoneIds,
  enabled,
  actorId = null,
  session = null,
}) => {
  const zoneIds = [...new Set((cityZoneIds || []).map(String))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  if (!zoneIds.length) return { updated: 0, enabled: Boolean(enabled) };

  const apply = async (txnSession) => {
    let zonesQuery = CityZone.find({ _id: { $in: zoneIds } })
      .select("_id operationalCityId");
    if (txnSession) zonesQuery = zonesQuery.session(txnSession);
    const zones = await zonesQuery.lean();
    if (zones.length !== zoneIds.length) {
      throw lifecycleError("ZONE_NOT_FOUND", "One or more city zones were not found", 404);
    }
    for (const zone of zones) {
      if (String(zone.operationalCityId) !== String(districtId)) {
        throw lifecycleError(
          "ZONE_DISTRICT_MISMATCH",
          `cityZoneId ${zone._id} does not belong to district ${districtId}`,
          400
        );
      }
    }

    const mapOps = zones.map((zone) => ({
      updateOne: {
        filter: { zoneId: zone._id, serviceId },
        update: {
          $set: { active: Boolean(enabled) },
          $setOnInsert: {
            zoneId: zone._id,
            serviceId,
            approvedBy: actorId,
            approvedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
    await ZoneServiceMapping.bulkWrite(mapOps, {
      ordered: false,
      ...(txnSession ? { session: txnSession } : {}),
    });

    const availOps = zones.map((zone) => ({
      updateOne: {
        filter: {
          serviceId,
          districtId,
          cityZoneId: zone._id,
          scope: "ZONE",
        },
        update: {
          $set: {
            serviceId,
            districtId,
            cityZoneId: zone._id,
            cityId: zone._id,
            scope: "ZONE",
            status: enabled ? "ENABLED" : "DISABLED",
            updatedBy: actorId,
          },
        },
        upsert: true,
      },
    }));
    await ServiceAvailability.bulkWrite(availOps, {
      ordered: false,
      ...(txnSession ? { session: txnSession } : {}),
    });

    return { updated: zones.length, enabled: Boolean(enabled) };
  };

  if (session) return apply(session);
  const { result } = await withZoneWriteTransaction(apply);
  return result;
};

/**
 * Remove a zone-service grant entirely. The mapping is deleted (not merely
 * disabled) and every zone-level override is removed so the district default
 * cannot be overridden by a stale row.
 */
export const removeZoneServiceMapping = async ({
  serviceId,
  districtId,
  cityZoneId,
  session = null,
}) => {
  const apply = async (txnSession) => {
    let zoneQuery = CityZone.findById(cityZoneId).select("_id operationalCityId");
    if (txnSession) zoneQuery = zoneQuery.session(txnSession);
    const zone = await zoneQuery.lean();
    if (!zone) throw lifecycleError("ZONE_NOT_FOUND", "City zone not found", 404);
    if (String(zone.operationalCityId) !== String(districtId)) {
      throw lifecycleError(
        "ZONE_DISTRICT_MISMATCH",
        "cityZoneId must belong to the supplied districtId",
        400
      );
    }

    const opts = txnSession ? { session: txnSession } : {};
    const mapping = await ZoneServiceMapping.findOneAndDelete(
      { zoneId: cityZoneId, serviceId },
      opts
    );
    await ServiceAvailability.deleteMany(
      {
        serviceId,
        scope: { $in: ["ZONE", "CITY"] },
        $or: [{ cityZoneId }, { cityId: cityZoneId }],
      },
      opts
    );
    return { zone, mapping };
  };

  if (session) return apply(session);
  const { result } = await withZoneWriteTransaction(apply);
  return result;
};

/** Bulk form for one zone and many services (zone mapping create endpoint). */
export const setZoneServicesForZone = async ({
  districtId,
  cityZoneId,
  serviceIds,
  enabled,
  actorId = null,
  session = null,
}) => {
  const ids = [...new Set((serviceIds || []).map(String))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  if (!ids.length) return { updated: 0, enabled: Boolean(enabled) };

  const apply = async (txnSession) => {
    let zoneQuery = CityZone.findById(cityZoneId).select("_id operationalCityId");
    if (txnSession) zoneQuery = zoneQuery.session(txnSession);
    const zone = await zoneQuery.lean();
    if (!zone) throw lifecycleError("ZONE_NOT_FOUND", "City zone not found", 404);
    if (String(zone.operationalCityId) !== String(districtId)) {
      throw lifecycleError(
        "ZONE_DISTRICT_MISMATCH",
        "cityZoneId must belong to the supplied districtId",
        400
      );
    }

    const mapOps = ids.map((serviceId) => ({
      updateOne: {
        filter: { zoneId: cityZoneId, serviceId },
        update: {
          $set: { active: Boolean(enabled) },
          $setOnInsert: {
            zoneId: cityZoneId,
            serviceId,
            approvedBy: actorId,
            approvedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
    await ZoneServiceMapping.bulkWrite(mapOps, {
      ordered: false,
      ...(txnSession ? { session: txnSession } : {}),
    });

    const availOps = ids.map((serviceId) => ({
      updateOne: {
        filter: { serviceId, districtId, cityZoneId, scope: "ZONE" },
        update: {
          $set: {
            serviceId,
            districtId,
            cityZoneId,
            cityId: cityZoneId,
            scope: "ZONE",
            status: enabled ? "ENABLED" : "DISABLED",
            updatedBy: actorId,
          },
        },
        upsert: true,
      },
    }));
    await ServiceAvailability.bulkWrite(availOps, {
      ordered: false,
      ...(txnSession ? { session: txnSession } : {}),
    });

    return { updated: ids.length, enabled: Boolean(enabled) };
  };

  if (session) return apply(session);
  const { result } = await withZoneWriteTransaction(apply);
  return result;
};

/**
 * When a service is created/activated, make sure every active zone has a
 * mapping and canonical row. Existing explicit per-zone state is preserved.
 * When a service is deactivated, all zones are explicitly disabled so a later
 * activation cannot silently re-open old approvals.
 */
export const syncServiceToZones = async ({ serviceId, actorId = null, session = null }) => {
  const apply = async (txnSession) => {
    let serviceQuery = Service.findById(serviceId).select("_id isActive");
    if (txnSession) serviceQuery = serviceQuery.session(txnSession);
    const service = await serviceQuery.lean();
    if (!service) {
      throw lifecycleError("SERVICE_NOT_FOUND", "Service not found", 404);
    }

    let zonesQuery = CityZone.find({ active: { $ne: false } })
      .select("_id operationalCityId serviceMode");
    if (txnSession) zonesQuery = zonesQuery.session(txnSession);
    const allZones = await zonesQuery.lean();

    const candidateDistrictIds = [
      ...new Set(allZones.map((zone) => String(zone.operationalCityId))),
    ];
    let districtsQuery = OperationalCity.find({ _id: { $in: candidateDistrictIds } })
      .select("_id");
    if (txnSession) districtsQuery = districtsQuery.session(txnSession);
    const existingDistricts = await districtsQuery.lean();
    const validDistrictIds = new Set(
      existingDistricts.map((district) => String(district._id))
    );
    const zones = allZones.filter((zone) =>
      validDistrictIds.has(String(zone.operationalCityId))
    );
    if (!zones.length) return { total: 0, enabled: 0, disabled: 0 };

    const zoneIds = zones.map((zone) => zone._id);
    const districtIds = [...new Set(zones.map((zone) => String(zone.operationalCityId)))];

    let mappingQuery = ZoneServiceMapping.find({
      serviceId,
      zoneId: { $in: zoneIds },
    }).select("zoneId active");
    if (txnSession) mappingQuery = mappingQuery.session(txnSession);
    const mappings = await mappingQuery.lean();

    let canonicalQuery = ServiceAvailability.find({
      serviceId,
      cityZoneId: { $in: zoneIds },
      scope: "ZONE",
    }).select("cityZoneId status");
    if (txnSession) canonicalQuery = canonicalQuery.session(txnSession);
    const canonicalRows = await canonicalQuery.lean();

    let defaultsQuery = ServiceAvailability.find({
      serviceId,
      districtId: { $in: districtIds },
      scope: "DISTRICT",
      cityZoneId: null,
    }).select("districtId status");
    if (txnSession) defaultsQuery = defaultsQuery.session(txnSession);
    const districtDefaults = await defaultsQuery.lean();

    const mappingByZone = new Map(mappings.map((row) => [String(row.zoneId), row]));
    const canonicalByZone = new Map(
      canonicalRows.map((row) => [String(row.cityZoneId), row])
    );
    const defaultByDistrict = new Map(
      districtDefaults.map((row) => [String(row.districtId), row.status])
    );

    const mapOps = [];
    const availOps = [];
    let enabledCount = 0;
    let disabledCount = 0;

    for (const zone of zones) {
      const mapping = mappingByZone.get(String(zone._id));
      const canonical = canonicalByZone.get(String(zone._id));

      let enabled;
      if (!service.isActive) {
        enabled = false;
      } else if (mapping || canonical) {
        if (mapping && canonical) {
          // Explicit state already exists. Reconciliation handles conflicts.
          continue;
        }
        enabled = mapping ? mapping.active === true : canonical.status === "ENABLED";
      } else {
        const mode = normalizeZoneServiceMode(zone.serviceMode);
        if (mode === "ENABLE_ALL") enabled = true;
        else if (mode === "DISABLE_ALL") enabled = false;
        else enabled = defaultByDistrict.get(String(zone.operationalCityId)) !== "DISABLED";
      }

      if (enabled) enabledCount += 1;
      else disabledCount += 1;

      mapOps.push({
        updateOne: {
          filter: { zoneId: zone._id, serviceId },
          update: {
            $set: { active: enabled },
            $setOnInsert: {
              zoneId: zone._id,
              serviceId,
              approvedBy: actorId,
              approvedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
      availOps.push({
        updateOne: {
          filter: {
            serviceId,
            districtId: zone.operationalCityId,
            cityZoneId: zone._id,
            scope: "ZONE",
          },
          update: {
            $set: {
              serviceId,
              districtId: zone.operationalCityId,
              cityZoneId: zone._id,
              cityId: zone._id,
              scope: "ZONE",
              status: enabled ? "ENABLED" : "DISABLED",
              updatedBy: actorId,
            },
          },
          upsert: true,
        },
      });
    }

    if (mapOps.length) {
      await ZoneServiceMapping.bulkWrite(mapOps, {
        ordered: false,
        ...(txnSession ? { session: txnSession } : {}),
      });
    }
    if (availOps.length) {
      await ServiceAvailability.bulkWrite(availOps, {
        ordered: false,
        ...(txnSession ? { session: txnSession } : {}),
      });
    }

    return {
      total: zones.length,
      enabled: enabledCount,
      disabled: disabledCount,
      unchanged: zones.length - mapOps.length,
    };
  };

  if (session) return apply(session);
  const { result } = await withZoneWriteTransaction(apply);
  return result;
};

/**
 * Safe zone deletion. Active jobs block the delete so existing customers are
 * never silently interrupted. Cleanup and revalidation are best-effort after
 * the committed transaction.
 */
export const deleteZoneCascade = async ({ zoneId, actorId = null, io = null, session = null }) => {
  const apply = async (txnSession) => {
    let zoneQuery = CityZone.findById(zoneId);
    if (txnSession) zoneQuery = zoneQuery.session(txnSession);
    const zone = await zoneQuery;
    if (!zone) return null;

    let activeJobsQuery = ServiceBooking.countDocuments({
      cityZoneId: zone._id,
      status: { $in: ACTIVE_BOOKING_STATUSES },
    });
    if (txnSession) activeJobsQuery = activeJobsQuery.session(txnSession);
    const activeJobs = await activeJobsQuery;
    if (activeJobs > 0) {
      throw lifecycleError(
        "ZONE_HAS_ACTIVE_BOOKINGS",
        `Cannot delete zone: ${activeJobs} active booking(s) still reference it`,
        409,
        { activeBookings: activeJobs }
      );
    }

    const opts = txnSession ? { session: txnSession } : {};
    const zoneObjId = zone._id;
    await CityZone.deleteOne({ _id: zoneObjId }, opts);
    await ZoneServiceMapping.deleteMany({ zoneId: zoneObjId }, opts);
    await ServiceAvailability.deleteMany(
      { $or: [{ cityZoneId: zoneObjId }, { cityId: zoneObjId }] },
      opts
    );

    let pullQuery = TechnicianProfile.updateMany(
      { enabledCityZoneIds: zoneObjId },
      { $pull: { enabledCityZoneIds: zoneObjId } }
    );
    if (txnSession) pullQuery = pullQuery.session(txnSession);
    await pullQuery;

    let registeredQuery = TechnicianProfile.updateMany(
      { cityZoneId: zoneObjId },
      { $set: { cityZoneId: null, zoneMismatch: false, zoneMismatchSince: null } }
    );
    if (txnSession) registeredQuery = registeredQuery.session(txnSession);
    await registeredQuery;

    let currentQuery = TechnicianProfile.updateMany(
      { currentCityZoneId: zoneObjId },
      { $set: { currentCityZoneId: null, zoneMismatch: false, zoneMismatchSince: null } }
    );
    if (txnSession) currentQuery = currentQuery.session(txnSession);
    await currentQuery;

    return zone;
  };

  let zone;
  if (session) {
    zone = await apply(session);
  } else {
    const { result } = await withZoneWriteTransaction(apply);
    zone = result;
  }

  if (zone && !session) {
    const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
    await revalidateTechniciansForService(null, zone.operationalCityId, zone._id, io).catch((err) =>
      console.warn("zone delete revalidation warning:", err.message)
    );
  }

  return zone;
};

/**
 * Safe district deletion. Cascades zones, mappings, availability, technician
 * district permissions and profile caches in one transaction. Active jobs
 * block the operation so no customer is interrupted.
 */
export const deleteDistrictCascade = async ({
  districtId,
  actorId = null,
  io = null,
  session = null,
}) => {
  const apply = async (txnSession) => {
    let districtQuery = OperationalCity.findById(districtId);
    if (txnSession) districtQuery = districtQuery.session(txnSession);
    const district = await districtQuery;
    if (!district) return null;

    let zonesQuery = CityZone.find({ operationalCityId: districtId }).select("_id");
    if (txnSession) zonesQuery = zonesQuery.session(txnSession);
    const zones = await zonesQuery.lean();
    const zoneIds = zones.map((zone) => zone._id);

    let activeJobsQuery = ServiceBooking.countDocuments({
      status: { $in: ACTIVE_BOOKING_STATUSES },
      $or: [
        { districtId },
        ...(zoneIds.length ? [{ cityZoneId: { $in: zoneIds } }] : []),
      ],
    });
    if (txnSession) activeJobsQuery = activeJobsQuery.session(txnSession);
    const activeJobs = await activeJobsQuery;
    if (activeJobs > 0) {
      throw lifecycleError(
        "DISTRICT_HAS_ACTIVE_BOOKINGS",
        `Cannot delete district: ${activeJobs} active booking(s) still reference it`,
        409,
        { activeBookings: activeJobs, zoneCount: zoneIds.length }
      );
    }

    const opts = txnSession ? { session: txnSession } : {};

    if (zoneIds.length) {
      await CityZone.deleteMany({ _id: { $in: zoneIds } }, opts);
      await ZoneServiceMapping.deleteMany({ zoneId: { $in: zoneIds } }, opts);
    }
    await ServiceAvailability.deleteMany(
      {
        $or: [
          { districtId },
          ...(zoneIds.length
            ? [{ cityZoneId: { $in: zoneIds } }, { cityId: { $in: zoneIds } }]
            : []),
        ],
      },
      opts
    );
    await TechnicianDistrictPermission.deleteMany({ districtId }, opts);

    if (zoneIds.length) {
      let pullZonesQuery = TechnicianProfile.updateMany(
        { enabledCityZoneIds: { $in: zoneIds } },
        { $pull: { enabledCityZoneIds: { $in: zoneIds } } }
      );
      if (txnSession) pullZonesQuery = pullZonesQuery.session(txnSession);
      await pullZonesQuery;

      let registeredQuery = TechnicianProfile.updateMany(
        { cityZoneId: { $in: zoneIds } },
        { $set: { cityZoneId: null, zoneMismatch: false, zoneMismatchSince: null } }
      );
      if (txnSession) registeredQuery = registeredQuery.session(txnSession);
      await registeredQuery;

      let currentZoneQuery = TechnicianProfile.updateMany(
        { currentCityZoneId: { $in: zoneIds } },
        { $set: { currentCityZoneId: null, zoneMismatch: false, zoneMismatchSince: null } }
      );
      if (txnSession) currentZoneQuery = currentZoneQuery.session(txnSession);
      await currentZoneQuery;
    }

    let pullDistrictQuery = TechnicianProfile.updateMany(
      {
        $or: [
          { enabledDistrictIds: districtId },
          { allowedCityIds: districtId },
        ],
      },
      { $pull: { enabledDistrictIds: districtId, allowedCityIds: districtId } }
    );
    if (txnSession) pullDistrictQuery = pullDistrictQuery.session(txnSession);
    await pullDistrictQuery;

    let primaryQuery = TechnicianProfile.updateMany(
      {
        $or: [
          { primaryDistrictId: districtId },
          { primaryCityId: districtId },
        ],
      },
      { $set: { primaryDistrictId: null, primaryCityId: null } }
    );
    if (txnSession) primaryQuery = primaryQuery.session(txnSession);
    await primaryQuery;

    let currentDistrictQuery = TechnicianProfile.updateMany(
      { currentDistrictId: districtId },
      { $set: { currentDistrictId: null } }
    );
    if (txnSession) currentDistrictQuery = currentDistrictQuery.session(txnSession);
    await currentDistrictQuery;

    await OperationalCity.deleteOne({ _id: districtId }, opts);

    return { district, zoneCount: zoneIds.length };
  };

  let result;
  if (session) {
    result = await apply(session);
  } else {
    const tx = await withZoneWriteTransaction(apply);
    result = tx.result;
  }

  if (result && !session) {
    invalidateOperationalPolygonCache();
    const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
    await revalidateTechniciansForService(null, districtId, null, io).catch((err) =>
      console.warn("district delete revalidation warning:", err.message)
    );
  }

  return result;
};

/**
 * Run fn(session) inside a multi-document transaction when the topology
 * supports it (production replica set, enforced at boot). Standalone dev
 * instances fall back to sequential writes with a loud warning so local
 * development keeps working; production always takes the atomic path.
 */
export const withZoneWriteTransaction = async (fn) => {
  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return { result, transactional: true };
    } catch (err) {
      const msg = err?.message || "";
      const standalone =
        /only allowed on a replica set|requires a replica set|not a replica set|Transaction numbers are only allowed/i.test(msg);
      if (!standalone) throw err;
      console.warn("[zoneWriteService] standalone topology — retrying zone write non-transactionally (dev-only fallback)");
      await session.endSession();
      return { result: await fn(null), transactional: false };
    }
  } finally {
    try {
      await session.endSession();
    } catch {
      /* already ended on fallback path */
    }
  }
};

export const invalidateDistrictPolygonCache = (districtId = null) =>
  invalidateOperationalPolygonCache(districtId);
