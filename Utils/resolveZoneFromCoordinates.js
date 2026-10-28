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

