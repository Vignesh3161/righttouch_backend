import mongoose from "mongoose";
import CityZone from "../Schemas/CityZone.js";
import OperationalCity from "../Schemas/OperationalCity.js";

/**
 * 🗺 RESOLVE ZONE FROM COORDINATES
 *
 * Given a lat/lng point, finds the CityZone whose polygon contains it.
 * Uses Mongo's $geoIntersects (2dsphere index) — never hand-rolled PIP.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @param {Object} [options]
 * @param {string} [options.operationalCityId] — restrict to a specific operational city
 * @param {string} [options.session] — optional Mongo session
 * @returns {{ zone: Object|null, error?: string }}
 */
export const resolveZoneFromCoordinates = async (
  latitude,
  longitude,
  { operationalCityId, session, includeInactive = false } = {}
) => {
  // Single source of truth: always resolve the parent district first, then a
  // zone inside that district. This prevents orphan zones (parent deleted) and
  // cross-district overlap from producing a different answer than booking.
  const resolved = await resolveDistrictAndZoneFromCoordinates(latitude, longitude, {
    session,
    includeInactiveZone: includeInactive,
    districtId: operationalCityId || null,
  });
  return {
    zone: resolved.zone,
    district: resolved.district,
    error: resolved.error,
  };
};

/**
 * Resolve multiple zones for a set of coordinates.
 * Returns an array of zone documents whose polygons contain the point.
 */
export const resolveAllZonesFromCoordinates = async (
  latitude,
  longitude,
  { session } = {}
) => {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return [];
  }

  const pointGeo = {
    $geoIntersects: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
    },
  };

  let districtQuery = OperationalCity.find({
    active: true,
    polygon: pointGeo,
  }).select("_id").lean();
  if (session) districtQuery = districtQuery.session(session);
  const districts = await districtQuery;

  let zoneQuery = CityZone.find({
    active: true,
    operationalCityId: { $in: districts.map((district) => district._id) },
    polygon: pointGeo,
  }).lean();

  if (session) zoneQuery = zoneQuery.session(session);

  return zoneQuery;
};

const ringAreaScore = (ring) => {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(area / 2);
};

const zoneAreaScore = (zone) => {
  const geometry = zone?.polygon;
  if (!geometry?.coordinates) return Number.POSITIVE_INFINITY;
  if (geometry.type === "Polygon") return ringAreaScore(geometry.coordinates[0]);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.reduce((total, part) => total + ringAreaScore(part?.[0]), 0);
  }
  return Number.POSITIVE_INFINITY;
};

/**
 * Resolve the zone that actually offers a requested service at a coordinate.
 *
 * Overlapping zones are allowed. A plain `findOne()` would pick an arbitrary
 * zone and could incorrectly report a service as unavailable when another
 * overlapping zone provides it. This resolver evaluates every active zone
 * containing the point and chooses the most specific (smallest) matching zone,
 * then falls back to a stable _id order.
 */
export const resolveServiceZoneFromCoordinates = async (
  serviceId,
  latitude,
  longitude,
  { session, districtId = null } = {}
) => {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { district: null, zone: null, zones: [], error: "Invalid coordinates", reason: "LOCATION_REQUIRED" };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { district: null, zone: null, zones: [], error: "Coordinates out of range", reason: "LOCATION_REQUIRED" };
  }
  if (!serviceId || !mongoose.Types.ObjectId.isValid(String(serviceId))) {
    return { district: null, zone: null, zones: [], error: "Invalid service", reason: "INVALID_SERVICE" };
  }

  const pointGeo = {
    $geoIntersects: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
    },
  };

  let districtQuery = districtId
    ? OperationalCity.findOne({ _id: districtId, active: true }).lean()
    : OperationalCity.findOne({ active: true, polygon: pointGeo }).sort({ _id: 1 }).lean();
  if (session) districtQuery = districtQuery.session(session);
  const district = await districtQuery;

  if (!district) {
    return { district: null, zone: null, zones: [], error: "NO_ACTIVE_DISTRICT", reason: "DISTRICT_REQUIRED" };
  }

  let zoneQuery = CityZone.find({
    operationalCityId: district._id,
    polygon: pointGeo,
  }).lean();
  if (session) zoneQuery = zoneQuery.session(session);
  const zones = await zoneQuery;

  if (!zones.length) {
    return { district, zone: null, zones: [], error: "ZONE_REQUIRED", reason: "ZONE_REQUIRED" };
  }

  const activeZones = zones.filter((zone) => zone.active !== false);
  if (!activeZones.length) {
    return { district, zone: zones[0], zones, error: "ZONE_INACTIVE", reason: "ZONE_INACTIVE" };
  }

  const { getAvailabilitySnapshot } = await import("../Services/serviceAvailabilityService.js");
  const snapshot = await getAvailabilitySnapshot({
    serviceIds: [serviceId],
    districtIds: [district._id],
    zoneIds: activeZones.map((zone) => zone._id),
  });

  const evaluated = activeZones.map((zone) => ({
    zone,
    availability: snapshot.evaluate(serviceId, district._id, zone._id),
  }));
  const matching = evaluated.filter((entry) => entry.availability.available === true);

  if (!matching.length) {
    const first = evaluated[0];
    return {
      district,
      zone: first?.zone || null,
      zones,
      error: "SERVICE_NOT_AVAILABLE",
      reason: first?.availability?.reason || "SERVICE_NOT_AVAILABLE",
      availability: first?.availability || null,
    };
  }

  matching.sort((a, b) => {
    const areaDiff = zoneAreaScore(a.zone) - zoneAreaScore(b.zone);
    if (areaDiff !== 0) return areaDiff;
    return String(a.zone._id).localeCompare(String(b.zone._id));
  });

  return {
    district,
    zone: matching[0].zone,
    zones,
    matchingZones: matching.map((entry) => entry.zone),
    availability: matching[0].availability,
    error: null,
    reason: null,
  };
};

/**
 * 🗺 RESOLVE BOTH DISTRICT AND ZONE FROM GPS COORDINATES
 *
 * Checks MongoDB $geoIntersects on both OperationalCity (District) and CityZone.
 * Returns { district, zone, error }
 */
export const resolveDistrictAndZoneFromCoordinates = async (
  latitude,
  longitude,
  { session, includeInactiveZone = false, districtId = null, includeInactiveDistrict = false } = {}
) => {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { district: null, zone: null, error: "Invalid coordinates" };
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { district: null, zone: null, error: "Coordinates out of range" };
  }

  const pointGeo = {
    $geoIntersects: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
    },
  };

  let district;
  if (districtId) {
    let distQuery = OperationalCity.findOne({
      _id: districtId,
      ...(includeInactiveDistrict ? {} : { active: true }),
    }).lean();
    if (session) distQuery = distQuery.session(session);
    district = await distQuery;
    if (!district) {
      return { district: null, zone: null, error: "NO_ACTIVE_DISTRICT" };
    }
    if (district.polygon) {
      let insideQuery = OperationalCity.exists({
        _id: district._id,
        polygon: pointGeo,
      });
      if (session) insideQuery = insideQuery.session(session);
      const inside = await insideQuery;
      if (!inside) {
        return { district: null, zone: null, error: "POINT_OUTSIDE_DISTRICT" };
      }
    }
  } else {
    let distQuery = OperationalCity.findOne({
      active: true,
      polygon: pointGeo,
    })
      .sort({ _id: 1 })
      .lean();
    if (session) distQuery = distQuery.session(session);
    district = await distQuery;
  }

  if (!district) {
    // No active parent district means no valid zone either — orphan zones are
    // never returned to booking/listing callers.
    return { district: null, zone: null, error: "NO_ACTIVE_DISTRICT" };
  }

  let zoneQuery = CityZone.findOne({
    operationalCityId: district._id,
    ...(includeInactiveZone ? {} : { active: true }),
    polygon: pointGeo,
  })
    .sort({ _id: 1 })
    .lean();
  if (session) zoneQuery = zoneQuery.session(session);
  const zone = await zoneQuery;

  return { district, zone: zone || null };
};

