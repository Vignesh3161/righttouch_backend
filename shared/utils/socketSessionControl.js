import { SOCKET_EVENTS } from "./socketConstants.js";
import { getRedisClient, isRedisAvailable } from "./redisDedupe.js";

const REVOKE_CHANNEL = "rt:session-revoke";

/**
 * P5 cross-instance fan-out over the EXISTING shared Redis client (no new
 * infrastructure). Best-effort and synchronous-safe: when Redis is down
 * (tests, single-instance dev) this is a no-op — local disconnects above
 * already provide deterministic behavior. Never throws, never logs tokens.
 */
export const publishSessionRevocation = (payload) => {
  try {
    const client = getRedisClientSync();
    client?.publish?.(REVOKE_CHANNEL, JSON.stringify(payload || {}))?.catch?.(() => {});
  } catch {}
};

// Only a previously warmed, still-open client ever publishes: this keeps
// the request path synchronous-safe (no connect attempts, no hangs) when
// Redis is down (tests, single-instance dev).
let liveRedisClient = null;
export const setRevokePublisher = (client) => {
  liveRedisClient = client || null;
};
const getLiveRedisClient = () => (liveRedisClient?.isOpen ? liveRedisClient : null);
const getRedisClientSync = () => (isRedisAvailable() ? getLiveRedisClient() : null);

/** Warms the shared client once (called from index.js after boot). */
export const warmRevokePublisher = async () => {
  try {
    const client = await getRedisClient();
    if (client?.isOpen) setRevokePublisher(client);
  } catch {}
};

/**
 * Applied on EVERY replica (local subscriber + remote messages): drop
 * local sockets matching the revocation. sid null/undefined ⇒ whole user.
 */
export const handleRemoteSessionRevocation = (io, { userId, sid } = {}) => {
  if (!io || !userId) return 0;
  let count = 0;
  try {
    for (const socket of io.sockets.sockets.values()) {
      if (!socket?.user?.userId || String(socket.user.userId) !== String(userId)) continue;
      if (sid && (!socket?.sessionId || String(socket.sessionId) !== String(sid))) continue;
      try {
        socket.emit(SOCKET_EVENTS.SESSION_REVOKED, {
          reason: "Your session was revoked. Please sign in again.",
        });
        socket.disconnect(true);
        count += 1;
      } catch {}
    }
  } catch {}
  return count;
};

export const revokeChannelName = () => REVOKE_CHANNEL;

/**
 * 🔐 SESSION CONTROL
 * Force-disconnects a technician's sockets when their status changes
 * (suspended / training revoked / KYC flagged). The client must treat
 * `session:revoked` as a forced logout and re-authenticate through REST
 * before reconnecting — so the fresh JWT reflects the new status.
 * Closes Socket Analysis B1.5 (stale JWT claims live for the whole session).
 */
export const revokeSocketSession = (io, technicianId, reason) => {
    if (!io || !technicianId) return;

    const room = `technician_${technicianId}`;
    io.to(room).emit(SOCKET_EVENTS.SESSION_REVOKED, {
        reason: reason || "Your account status changed. Please sign in again.",
    });
    io.in(room).disconnectSockets(true);

    console.log(`🔐 Session revoked for technician ${technicianId} (${reason})`);
};

/**
 * P5 — per-session socket revocation (single-device logout).
 *
 * Only sockets bound to the revoked `sid` are disconnected; other
 * devices' sockets stay live. Local sockets disconnect directly;
 * cross-instance replicas observe the same event through the shared
 * Redis adapter room broadcast and drop their matching sockets.
 * Never logs tokens — only ids/reasons.
 */
export const revokeSocketsForSession = (io, userId, sid) => {
    if (!io || !userId || !sid) return 0;
    const count = handleRemoteSessionRevocation(io, { userId, sid });
    // Cross-instance: every replica drops its own matching sockets.
    // (Local sockets already handled above; the room event keeps
    // already-connected clients informed without leaking tokens.)
    try {
        io.to(`user:${userId}`).emit(SOCKET_EVENTS.SESSION_REVOKED, {
            reason: "A session was revoked. Logged-out devices must sign in again.",
            sid: String(sid),
        });
    } catch {}
    publishSessionRevocation({ userId: String(userId), sid: String(sid) });
    return count;
};

/**
 * P5 — whole-user socket revocation (logout-all / global invalidation).
 * Disconnects every socket of the user on this instance and broadcasts
 * the revocation room-wide for other replicas.
 */
export const revokeSocketsForUser = (io, userId) => {
    if (!io || !userId) return 0;
    const count = handleRemoteSessionRevocation(io, { userId });
    try {
        io.to(`user:${userId}`).emit(SOCKET_EVENTS.SESSION_REVOKED, {
            reason: "All sessions revoked. Please sign in again.",
        });
    } catch {}
    publishSessionRevocation({ userId: String(userId), sid: null });
    return count;
};