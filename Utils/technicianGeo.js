/**
 * 🗺️ TECHNICIAN GEO LAYER — (Redis Disabled: MongoDB Native 2dsphere)
 *
 * Location pings land directly in MongoDB (durability, 2dsphere indexing,
 * operational polygon, and staleness filtering).
 * Redis is completely disabled — matching uses MongoDB $nearSphere native path.
 */

export const GEO_KEY = "tech_locations";

export const ensureConnected = async () => ({ ok: false, available: false, reason: "redis_disabled" });

/** Upsert technician position — no-op (MongoDB stores the location coordinates) */
export const geoAdd = async () => ({ ok: true, skipped: true });

/** Radius search — returns null so caller uses MongoDB $nearSphere (2dsphere index) */
export const geoSearch = async () => null;

/** Remove technician position — no-op */
export const geoRemove = async () => ({ ok: true, skipped: true });

export const geoAvailable = async () => false;

export default {
  ensureConnected,
  geoAdd,
  geoSearch,
  geoRemove,
  geoAvailable,
};
