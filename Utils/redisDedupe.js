import { createClient } from "redis";

let redisClient = null;
let isConnected = false;

export async function getRedisClient() {
  if (redisClient && isConnected) return redisClient;
  
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  redisClient = createClient({ 
    url: redisUrl,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
    }
  });
  
  redisClient.on('error', (err) => {
    console.error('[Redis Dedupe] Client error:', err.message);
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
  return isConnected && redisClient?.isOpen;
}