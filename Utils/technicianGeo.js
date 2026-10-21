/**
 * 🗺️ TECHNICIAN GEO LAYER — Redis GEO + MongoDB 2dsphere Hybrid
 * 
 * Uses Redis GEOSEARCH for fast candidate pre-filtering (sub-ms),
 * then MongoDB $nearSphere for exact matching with full filters.
 * Falls back gracefully to MongoDB-only if Redis unavailable.
 */

import { createClient } from "redis";

export const GEO_KEY = "tech_locations";

const CONNECT_RETRY_MS = 30000;

let redisClient = null;
let isGeoAvailable = false;
let connectPromise = null;
let lastConnectAttempt = 0;

async function getRedisClient() {
  if (redisClient?.isReady) {
    isGeoAvailable = true;
    return redisClient;
  }

  if (connectPromise) return connectPromise;
  // Existing client is auto-reconnecting; fall back instead of opening a second one.
  if (redisClient?.isOpen) return null;
  if (Date.now() - lastConnectAttempt < CONNECT_RETRY_MS) return null;
  lastConnectAttempt = Date.now();

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 1000,
      reconnectStrategy: (retries) => (retries > 2 ? false : Math.min(retries * 100, 3000)),
    },
  });

  client.on('error', (err) => {
    console.warn('[Redis GEO] Client error:', err.message);
    isGeoAvailable = false;
  });

  connectPromise = client
    .connect()
    .then(() => {
      redisClient = client;
      isGeoAvailable = true;
      client.unref();
      console.log('[Redis GEO] Connected');
      return client;
    })
    .catch((err) => {
      console.warn('[Redis GEO] Connection failed, using MongoDB-only:', err.message);
      isGeoAvailable = false;
      client.disconnect().catch(() => {});
      return null;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

export const ensureConnected = async () => {
  const client = await getRedisClient();
  return { ok: Boolean(client), available: isGeoAvailable };
};

/** Upsert technician position in Redis GEO */
export const geoAdd = async (technicianId, longitude, latitude) => {
  try {
    const client = await getRedisClient();
    if (!client) return { ok: true, skipped: true };

    await client.geoAdd(GEO_KEY, { longitude, latitude, member: technicianId.toString() });
    return { ok: true };
  } catch (err) {
    console.warn('[Redis GEO] geoAdd failed:', err.message);
    isGeoAvailable = false;
    return { ok: false, error: err.message };
  }
};

/** Radius search in Redis — returns technician IDs within radius */
export const geoSearch = async (longitude, latitude, radiusMeters = 10000, limit = 100) => {
  try {
    const client = await getRedisClient();
    if (!client) return null;

    const results = await client.geoSearchWith(
      GEO_KEY,
      { longitude, latitude },
      { radius: radiusMeters, unit: 'M' },
      ['WITHCOORD', 'WITHDIST'],
      { COUNT: limit }
    );

    return results.map((r) => ({
      technicianId: r.member,
      distanceMeters: r.distance != null ? Math.round(parseFloat(r.distance)) : null,
      coordinates: r.coordinates
        ? [parseFloat(r.coordinates.longitude), parseFloat(r.coordinates.latitude)]
        : [longitude, latitude],
    }));
  } catch (err) {
    console.warn('[Redis GEO] geoSearch failed:', err.message);
    isGeoAvailable = false;
    return null;
  }
};

/** Remove technician position from Redis GEO */
export const geoRemove = async (technicianId) => {
  try {
    const client = await getRedisClient();
    if (!client) return { ok: true, skipped: true };

    await client.zRem(GEO_KEY, technicianId.toString());
    return { ok: true };
  } catch (err) {
    console.warn('[Redis GEO] geoRemove failed:', err.message);
    isGeoAvailable = false;
    return { ok: false, error: err.message };
  }
};

export const geoAvailable = async () => isGeoAvailable;

export default {
  ensureConnected,
  geoAdd,
  geoSearch,
  geoRemove,
  geoAvailable,
};
