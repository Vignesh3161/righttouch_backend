import { SOCKET_EVENTS } from "./socketConstants.js";

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