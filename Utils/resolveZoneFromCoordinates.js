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
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { zone: null, error: "Invalid coordinates" };
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { zone: null, error: "Coordinates out of range" };
  }

  // Required architecture: deactivated zones must BLOCK booking.
  // Callers that enforce checkout/listing must pass includeInactive:true so an
  // inactive polygon is still detected (otherwise active-only lookup returns
  // null and the resolver would fall back to district and wrongly allow).
  const query = {
    ...(includeInactive ? {} : { active: true }),
    polygon: {
      $geoIntersects: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
      },
    },
  };

  if (operationalCityId) {
    query.operationalCityId = operationalCityId;
  }

  let zoneQuery = CityZone.findOne(query).lean();
  if (session) zoneQuery = zoneQuery.session(session);

  const zone = await zoneQuery;
  return { zone: zone || null };
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

  let zoneQuery = CityZone.find({
    active: true,
    polygon: {
      $geoIntersects: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
      },
    },
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
  { session, includeInactiveZone = false } = {}
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

  let distQuery = OperationalCity.findOne({
    active: true,
    polygon: pointGeo,
  }).lean();
  if (session) distQuery = distQuery.session(session);
  const district = await distQuery;

  let zoneQuery = null;
  const zoneFilter = {
    ...(includeInactiveZone ? {} : { active: true }),
    polygon: pointGeo,
  };
  if (district) {
    zoneQuery = CityZone.findOne({
      operationalCityId: district._id,
      ...zoneFilter,
    }).lean();
  } else {
    zoneQuery = CityZone.findOne(zoneFilter).lean();
  }
  if (session && zoneQuery) zoneQuery = zoneQuery.session(session);
  const zone = zoneQuery ? await zoneQuery : null;

  return { district: district || null, zone: zone || null };
};

