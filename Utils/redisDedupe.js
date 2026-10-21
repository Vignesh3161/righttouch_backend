import { createClient } from "redis";

const CONNECT_RETRY_MS = 30000;

let redisClient = null;
let isConnected = false;
let connectPromise = null;
let lastConnectAttempt = 0;

export async function getRedisClient() {
  if (redisClient?.isReady) {
    isConnected = true;
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
      reconnectStrategy: (retries) => (retries > 2 ? false : Math.min(retries * 100, 3000))
    }
  });

  client.on('error', (err) => {
    console.error('[Redis Dedupe] Client error:', err.message);
    isConnected = false;
  });

  client.on('ready', () => {
    isConnected = true;
  });

  client.on('end', () => {
    isConnected = false;
  });

  connectPromise = client
    .connect()
    .then(() => {
      redisClient = client;
      isConnected = true;
      client.unref();
      console.log('[Redis Dedupe] Connected');
      return client;
    })
    .catch((err) => {
      console.warn('[Redis Dedupe] Connection failed, falling back to in-memory:', err.message);
      isConnected = false;
      client.disconnect().catch(() => {});
      return null;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

export async function closeRedisClient() {
  if (redisClient?.isOpen) {
    await redisClient.quit();
    isConnected = false;
    redisClient = null;
  }
}

export function isRedisAvailable() {
  return Boolean(redisClient?.isReady);
}
