import mongoose from "mongoose";
import CityZone from "../Schemas/CityZone.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import PolygonVersion from "../Schemas/PolygonVersion.js";
import Service from "../Schemas/Service.js";
import {
  validateAndSanitizePolygon,
  validateZoneInsideDistrict,
  checkZoneOverlap,
} from "../Utils/geoValidation.js";
import { invalidateOperationalPolygonCache } from "../Utils/technicianMatching.js";

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

  if (district.polygon) {
    const containment = validateZoneInsideDistrict(sanitizedPolygon, district.polygon);
    if (!containment.valid) {
      return { ok: false, status: 400, code: "ZONE_OUTSIDE_PARENT_DISTRICT", message: containment.reason };
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
  return { ok: true, district };
};

/**
 * Product policy: a new zone defaults every active service to DISABLED
 * (explicit admin enable required). Session-aware for transactional writes.
 */
export const seedZoneDisabledServices = async ({ zone, actorId = null, session = null }) => {
  const activeServices = await Service.find({ isActive: true }).select("_id").lean();
  if (!activeServices.length) return 0;

  const mapOps = activeServices.map((s) => ({
    updateOne: {
      filter: { zoneId: zone._id, serviceId: s._id },
      update: {
        $setOnInsert: { zoneId: zone._id, serviceId: s._id, approvedBy: actorId, approvedAt: new Date() },
        $set: { active: false },
      },
      upsert: true,
    },
  }));
  const mapRes = await ZoneServiceMapping.bulkWrite(mapOps, { ordered: false, ...(session ? { session } : {}) });

  const availOps = activeServices.map((s) => ({
    updateOne: {
      filter: { serviceId: s._id, districtId: zone.operationalCityId, cityZoneId: zone._id, scope: "ZONE" },
      update: {
        $set: {
          serviceId: s._id,
          districtId: zone.operationalCityId,
          cityZoneId: zone._id,
          scope: "ZONE",
          status: "DISABLED",
          updatedBy: actorId,
        },
      },
      upsert: true,
    },
  }));
  await ServiceAvailability.bulkWrite(availOps, { ordered: false, ...(session ? { session } : {}) });
  return mapRes.upsertedCount ?? activeServices.length;
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
