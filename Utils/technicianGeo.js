/**
 * 🗺️ TECHNICIAN GEO LAYER — Redis GEO + MongoDB 2dsphere Hybrid
 * 
 * Uses Redis GEORADIUS for fast candidate pre-filtering (sub-ms),
 * then MongoDB $nearSphere for exact matching with full filters.
 * Falls back gracefully to MongoDB-only if Redis unavailable.
 */

import { createClient } from "redis";

export const GEO_KEY = "tech_locations";

let redisClient = null;
let isGeoAvailable = false;

async function getRedisClient() {
  if (redisClient?.isOpen) return redisClient;
  
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  redisClient = createClient({ 
    url: redisUrl,
    socket: { connectTimeout: 3000 }
  });
  
  redisClient.on('error', (err) => {
    console.warn('[Redis GEO] Client error:', err.message);
    isGeoAvailable = false;
  });
  
  try {
    await redisClient.connect();
    isGeoAvailable = true;
  } catch (err) {
    console.warn('[Redis GEO] Connection failed, using MongoDB-only:', err.message);
    isGeoAvailable = false;
  }
  
  return redisClient;
}

export const ensureConnected = async () => {
  const client = await getRedisClient();
  return { ok: isGeoAvailable, available: isGeoAvailable };
};

/** Upsert technician position in Redis GEO */
export const geoAdd = async (technicianId, longitude, latitude) => {
  if (!isGeoAvailable) return { ok: true, skipped: true };
  
  try {
    const client = await getRedisClient();
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
  if (!isGeoAvailable) return null;
  
  try {
    const client = await getRedisClient();
    const results = await client.geoSearch(GEO_KEY, {
      longitude,
      latitude,
      radius: radiusMeters,
      unit: 'M',
      COUNT: limit,
      WITHCOORD: true,
      WITHDIST: true,
    });
    
    return results.map(r => ({
      technicianId: r.member,
      distanceMeters: Math.round(parseFloat(r.distance)),
      coordinates: [r.longitude, r.latitude]
    }));
  } catch (err) {
    console.warn('[Redis GEO] geoSearch failed:', err.message);
    isGeoAvailable = false;
    return null;
  }
};

/** Remove technician position from Redis GEO */
export const geoRemove = async (technicianId) => {
  if (!isGeoAvailable) return { ok: true, skipped: true };
  
  try {
    const client = await getRedisClient();
    await client.geoRemove(GEO_KEY, technicianId.toString());
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