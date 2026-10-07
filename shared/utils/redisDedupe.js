import { createClient } from "redis";

let redisClient = null;
let isConnected = false;
let disabledLogged = false;

/**
 * Redis is OPTIONAL. Set REDIS_ENABLED=true (or 1/yes) to use Redis.
 * Default = disabled → all callers use in-memory fallback, zero connections,
 * zero log spam. This lets you run temporarily without Redis.
 */
export function isRedisEnabled() {
  const v = String(process.env.REDIS_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export async function getRedisClient() {
  if (!isRedisEnabled()) {
    if (!disabledLogged) {
      console.log("[Redis Dedupe] disabled via REDIS_ENABLED (using in-memory fallback)");
      disabledLogged = true;
    }
    return null;
  }
  if (redisClient && isConnected) return redisClient;
  
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  // Close any stale client before recreating (prevents listener pile-up)
  if (redisClient) {
    try { await redisClient.quit().catch(() => {}); } catch {}
    redisClient = null;
  }
  redisClient = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 5000,
      // Limited retries then stop — prevents infinite ECONNREFUSED spam.
      // Reconnects are re-attempted lazily on next getRedisClient() call.
      reconnectStrategy: (retries) => (retries >= 3 ? false : Math.min(retries * 200, 1000)),
    },
    disableOfflineQueue: true,
  });

  let errorLogged = false;
  redisClient.on('error', (err) => {
    if (!errorLogged) {
      console.warn('[Redis Dedupe] unavailable, using in-memory fallback:', err.message);
      errorLogged = true;
    }
    isConnected = false;
  });
  
  redisClient.on('connect', () => {
    isConnected = true;
    console.log('[Redis Dedupe] Connected');
  });
  
  redisClient.on('reconnecting', () => {
    isConnected = false;
  });
  
  try {
    await redisClient.connect();
    isConnected = true;
  } catch (err) {
    console.warn('[Redis Dedupe] Connection failed, falling back to in-memory:', err.message);
    isConnected = false;
  }
  
  return redisClient;
}

export async function closeRedisClient() {
  if (redisClient && isConnected) {
    await redisClient.quit();
    isConnected = false;
  }
}

export function isRedisAvailable() {
  if (!isRedisEnabled()) return false;
  return isConnected && redisClient?.isOpen;
}