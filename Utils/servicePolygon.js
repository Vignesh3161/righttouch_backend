import mongoose from "mongoose";
import Service from "../Schemas/Service.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

/**
 * 🎯 SERVICE COVERAGE POLYGON helpers.
 *
 * Same concept as the operational-city polygon, but per-SERVICE:
 *   - Admin sets a GeoJSON polygon on a service (Polygon/MultiPolygon).
 *   - A customer may only BOOK the service from a location inside the polygon.
 *   - A technician may only be MATCHED for the service's jobs while inside
 *     the polygon.
 *   - No polygon on the service → unrestricted (backward compatible).
 */

/**
 * Validate a GeoJSON polygon geometry (Polygon / MultiPolygon).
 * Shared with the operational-city controller.
 * Returns an error string or null when valid.
 */
export const validateGeoJsonPolygon = (polygon) => {
  if (!polygon || !["Polygon", "MultiPolygon"].includes(polygon.type)) {
    return "polygon.type must be 'Polygon' or 'MultiPolygon'";
  }
  const coords = polygon.coordinates;
  if (!Array.isArray(coords) || coords.length === 0) {
    return "polygon.coordinates is required";
  }

  const validateRing = (ring, label) => {
    if (!Array.isArray(ring) || ring.length < 4) {
      return `${label}: a ring needs at least 4 points`;
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!Array.isArray(first) || !Array.isArray(last)) {
      return `${label}: point must be [lng, lat]`;
    }
    const [fLng, fLat, lLng, lLat] = [first[0], first[1], last[0], last[1]];
    if (![fLng, fLat, lLng, lLat].every(Number.isFinite)) {
      return `${label}: point coordinates must be numbers [lng, lat]`;
    }
    if (Math.abs(fLng - lLng) > 1e-9 || Math.abs(fLat - lLat) > 1e-9) {
      return `${label}: ring must be closed (first point === last point)`;
    }
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2 || !pt.slice(0, 2).every(Number.isFinite)) {
        return `${label}: each point must be [lng, lat] numbers`;
      }
    }
    return null;
  };

  if (polygon.type === "Polygon") {
    const err = validateRing(coords[0], "outer ring");
    if (err) return err;
  } else {
    for (let p = 0; p < coords.length; p++) {
      const poly = coords[p];
      if (!Array.isArray(poly) || poly.length === 0) {
        return `MultiPolygon[${p}]: must contain at least one ring`;
      }
      const err = validateRing(poly[0], `MultiPolygon[${p}] outer ring`);
      if (err) return err;
    }
  }
  return null;
};

/**
 * Check whether a lat/lng point is inside a service's coverage polygon.
 * Uses one indexed $geoIntersects query (2dsphere index on coveragePolygon).
 *
 * @param {string} serviceId
 * @param {number} latitude  (null → allowed only when the service has no polygon)
 * @param {number} longitude
 * @returns {{allowed: boolean, message?: string}}
 */
export const isServiceBookableAt = async ({ serviceId, latitude, longitude, session }) => {
  const serviceIdString = String(serviceId);
  const polygon = await Service.findById(serviceIdString)
    .select("coveragePolygon")
    .session(session)
    .lean();

  if (!polygon?.coveragePolygon) return { allowed: true };

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      allowed: false,
      message: "Location is required to book this service inside its coverage area",
    };
  }

  let agg = Service.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(serviceIdString),
        coveragePolygon: {
          $geoIntersects: {
            $geometry: { type: "Point", coordinates: [lng, lat] },
          },
        },
      },
    },
    { $limit: 1 },
  ]);
  if (session) agg = agg.session(session);
  const matched = await agg;
  if (matched.length === 0) {
    return {
      allowed: false,
      message: "This service is not available in your location",
    };
  }
  return { allowed: true };
};

/**
 * Keep only candidates whose live location is inside the service's coverage
 * polygon. No polygon on the service → techIds pass through unchanged.
 */
export const filterTechsByServicePolygon = async (techIds, serviceId, { session } = {}) => {
  if (!techIds.length) return techIds;
  const serviceIdString = String(serviceId);

  const svc = await Service.findById(serviceIdString)
    .select("coveragePolygon")
    .session(session)
    .lean();
  if (!svc?.coveragePolygon) return techIds;

  let q = TechnicianProfile.find({
    _id: { $in: techIds },
    location: { $geoIntersects: { $geometry: svc.coveragePolygon } },
  }).select("_id");
  if (session) q = q.session(session);
  const inside = await q.lean();

  const insideIds = new Set(inside.map((t) => String(t._id)));
  return techIds.filter((id) => insideIds.has(String(id)));
};