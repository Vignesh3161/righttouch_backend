/**
 * 🗺️ TECHNICIAN GEO LAYER — Redis GEO hot path for matching.
 *
 * Location pings land in Mongo (source of truth: durability, polygon,
 * staleness) AND here (hot path: sub-ms radius pre-filter for every
 * matching cycle). Everything is best-effort: if Redis is disabled or
 * unreachable the app degrades gracefully to the Mongo $nearSphere path —
 * Redis is an accelerator, never a gate.
 *
 * Enabled only when REDIS_URL is set and REDIS_ENABLED !== "false".
 */

import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || "";
const DISABLED = String(process.env.REDIS_ENABLED).toLowerCase() === "false";
export const GEO_KEY = "tech_locations";
const CONNECT_TIMEOUT_MS = 2000;
const RETRY_MS = 30_000;

let client = null;
let connectPromise = null;
let retryTimer = null;
let available = false;
let everConnected = false;

const markUnavailable = () => {
  available = false;
  if (!retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      everConnected = false; // allow reconnect attempt
      connectPromise = null;
      ensureConnected().catch(() => {});
    }, RETRY_MS);
    retryTimer.unref?.();
  }
};

/** Lazy singleton connect — no-op when disabled. Resolves { ok, available }. */
export const ensureConnected = async () => {
  if (DISABLED || !REDIS_URL) return { ok: false, available: false, reason: "disabled" };
  if (available) return { ok: true, available: true };
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      client = createClient({
        url: REDIS_URL,
        socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
      });
      client.on("error", (err) => {
        if (available || everConnected) {
          console.warn(`⚠️ Redis geo client error (falling back to Mongo): ${err.message}`);
        }
        available = false;
      });
      await client.connect();
      available = true;
      everConnected = true;
      console.log(`✅ Redis GEO layer connected via ${REDIS_URL}`);
      return { ok: true, available: true };
    } catch (err) {
      console.warn(`⚠️ Redis GEO unavailable (${err.message}) — matching uses Mongo radius path.`);
      available = false;
      markUnavailable();
      try { await client?.disconnect(); } catch { /* noop */ }
      client = null;
      return { ok: false, available: false, reason: err.message };
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
};

/** Upsert a technician's position into the GEO set. Best-effort. */
export const geoAdd = async (technicianId, longitude, latitude) => {
  if (!(await ensureConnected()).available) return { ok: false };
  try {
    await client.geoAdd(GEO_KEY, { longitude, latitude, member: String(technicianId) });
    return { ok: true };
  } catch (err) {
    markUnavailable();
    return { ok: false, error: err.message };
  }
};

/**
 * Radius search — returns [{ technicianId, distMeters }] sorted by distance.
 * Returns null when Redis is unavailable (caller falls back to Mongo).
 */
export const geoSearch = async (longitude, latitude, radiusMeters, limit = 100) => {
  if (!(await ensureConnected()).available) return null;
  try {
    const results = await client.geoSearchWith(GEO_KEY, {
      longitude,
      latitude,
    }, {
      radius: radiusMeters,
      unit: "m",
      count: limit,
      sort: "ASC",
    });
    return results.map((r) => ({
      technicianId: String(r.member),
      distMeters: Math.round((Number(r.distance) || 0) * 1000) / 1000,
    }));
  } catch (err) {
    markUnavailable();
    return null;
  }
};

/** Remove a technician (go-offline / deactivation). Best-effort. */
export const geoRemove = async (technicianId) => {
  if (!(await ensureConnected()).available) return { ok: false };
  try {
    await client.zRem(GEO_KEY, String(technicianId));
    return { ok: true };
  } catch (err) {
    markUnavailable();
    return { ok: false, error: err.message };
  }
};

export const geoAvailable = async () => (await ensureConnected()).available;
