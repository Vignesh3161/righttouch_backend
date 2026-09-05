import CityZone from "../Schemas/CityZone.js";

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
  { operationalCityId, session } = {}
) => {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { zone: null, error: "Invalid coordinates" };
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { zone: null, error: "Coordinates out of range" };
  }

  const query = {
    active: true,
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
