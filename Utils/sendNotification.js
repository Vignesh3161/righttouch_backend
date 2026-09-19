import { SOCKET_EVENTS, SOCKET_ROOMS } from "./socketConstants.js";
import { toJobNewDTO } from "./socketDTO.js";
import { checkTechnicianActivation } from "./technicianActivation.js";
import { recordAck } from "./socketMetrics.js";
import { sendFcmMulticast } from "./firebase.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import User from "../Schemas/User.js";
import DeviceToken from "../Schemas/DeviceToken.js";
import Notification from "../Schemas/Notification.js";
import { deactivateTokenByValue } from "./permissionService.js";
import { getRedisClient, isRedisAvailable } from "./redisDedupe.js";

/**
 * 📢 NOTIFICATION UTILITY
 * Handles push notifications, SMS, and real-time socket notifications
 */

/**
 * 🔌 LIVE SOCKET PRESENCE (O(1), synchronous)
 */
export const hasLiveSocket = (io, technicianId) => {
  try {
    if (!io || !technicianId) return false;
    const room = SOCKET_ROOMS.TECHNICIAN(technicianId);
    const nsp = io.of?.("/") || io;
    const roomSockets = nsp?.adapter?.rooms?.get(room);
    return Boolean(roomSockets && roomSockets.size > 0);
  } catch {
    return false;
  }
};

/**
 * 🛰 JOBS-CHANGED PUSH (Socket Analysis — anti-polling fix)
 */
export const emitJobsChanged = (io, technicianProfileId, { action, bookingId, broadcastId, reasons } = {}) => {
  try {
    if (!io || !technicianProfileId) return;
    io.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(
      SOCKET_EVENTS.TECH_JOBS_CHANGED,
      { changed: true, at: new Date().toISOString() }
    );
    // Also emit the flat jobs_changed event for client compatibility
    if (action || bookingId) {
      io.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(
        "jobs_changed",
        {
          action: action || "changed",
          bookingId: bookingId ? String(bookingId) : undefined,
          broadcastId: broadcastId ? String(broadcastId) : undefined,
          reasons: reasons || [],
          at: new Date().toISOString()
        }
      );
    }
  } catch (err) {
    console.error("emitJobsChanged error:", err.message);
  }
};

/**
 * 🛰 JOB-EXPIRED PUSH
 */
export const emitJobExpired = (io, technicianProfileId, { bookingId, broadcastId, expiresAt, reason, reasons } = {}) => {
  try {
    if (!io || !technicianProfileId || !bookingId) return;
    io.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(
      SOCKET_EVENTS.JOB_EXPIRED,
      {
        bookingId: String(bookingId),
        broadcastId: broadcastId ? String(broadcastId) : undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : new Date().toISOString(),
        reason: reason || "offer_expired",
        reasons: reasons || [reason || "offer_expired"],
      }
    );
    // Also emit jobs_changed with action removed for client to remove from list
    io.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(
      "jobs_changed",
      {
        action: "removed",
        bookingId: String(bookingId),
        broadcastId: broadcastId ? String(broadcastId) : undefined,
        reasons: reasons || [reason || "offer_expired"],
        at: new Date().toISOString()
      }
    );
  } catch (err) {
    console.error("emitJobExpired error:", err.message);
  }
};

/**
 * Send push notification via FCM to Customer, Technician, or Admin.
 * @param {String} recipientId - User _id or TechnicianProfile _id
 * @param {Object} payload - { title, body, data, badge }
 * @param {Object} [options] - { recipientType: "customer" | "technician" | "admin" }
 * @returns {Object} result
 */
/**
 * FCM error codes that indicate a PERMANENTLY invalid token.
 * These tokens will never work again and should be pruned.
 * Source: https://firebase.google.com/docs/cloud-messaging/manage-tokens
 */
const PERMANENT_TOKEN_FAILURE_CODES = new Set([
  "not-registered",      // App uninstalled, token expired
  "unregistered",        // Alias for not-registered
  "invalid-registration", // Token format invalid (malformed)
]);

/**
 * FCM error codes that indicate TEMPORARY or CONFIG issues.
 * These should NOT cause token pruning.
 */
const TEMPORARY_TOKEN_FAILURE_CODES = new Set([
  "invalid-argument",    // Often project mismatch or config issue
  "sender-id-mismatch",  // Project mismatch - CONFIG ISSUE
  "quota-exceeded",      // Rate limiting - TEMPORARY
  "unavailable",         // FCM service temporarily unavailable
  "internal",            // FCM internal error - TEMPORARY
  "third-party-auth-error", // APNs auth issue - TEMPORARY
]);

const isPermanentTokenFailure = (errorCode) => {
  if (!errorCode) return false;
  const code = String(errorCode).toLowerCase();
  return PERMANENT_TOKEN_FAILURE_CODES.has(code);
};

const isTemporaryTokenFailure = (errorCode) => {
  if (!errorCode) return false;
  const code = String(errorCode).toLowerCase();
  return TEMPORARY_TOKEN_FAILURE_CODES.has(code);
};

const pruneInvalidTokens = async (recipientId, recipientType, tokens, errorCodes = {}) => {
  if (!tokens || !tokens.length) return;
  const $pull = { fcmTokens: { $in: tokens } };
  try {
    if (recipientType === "technician") {
      await TechnicianProfile.updateOne({ _id: recipientId }, { $pull });
      const tech = await TechnicianProfile.findById(recipientId).select("userId").lean();
      if (tech?.userId) {
        await User.updateOne({ _id: tech.userId }, { $pull });
      }
    } else {
      await User.updateOne({ _id: recipientId }, { $pull });
    }
    // Also mark dead in DeviceToken collection
    await DeviceToken.updateMany({ fcmToken: { $in: tokens } }, { $set: { isActive: false } });
    console.log(`🧹 Pruned ${tokens.length} permanently invalid FCM token(s) for ${recipientType} ${recipientId}`);
  } catch (err) {
    console.warn(`⚠️ Token prune warning for ${recipientId}:`, err.message);
  }
};

export const sendPushNotification = async (recipientId, payload, options = {}) => {
  const recipientType = options.recipientType === "admin"
    ? "admin"
    : options.recipientType === "customer"
    ? "customer"
    : "technician";

  try {
    let rawTokens = [];

    // 1. Gather tokens from DeviceToken collection (active tokens)
    const deviceDocs = await DeviceToken.find({
      userId: recipientId,
      isActive: true,
    }).select("fcmToken").lean().catch(() => []);

    deviceDocs.forEach((d) => {
      if (d.fcmToken) rawTokens.push(d.fcmToken);
    });

    // 2. Gather tokens from legacy User / TechnicianProfile arrays
    if (recipientType === "customer" || recipientType === "admin") {
      const user = await User.findById(recipientId).select("fcmTokens").lean().catch(() => null);
      if (user?.fcmTokens) rawTokens.push(...user.fcmTokens);
    } else {
      const tech = await TechnicianProfile.findById(recipientId).select("fcmTokens userId").lean().catch(() => null);
      if (tech?.fcmTokens) rawTokens.push(...tech.fcmTokens);
      if (tech?.userId) {
        const user = await User.findById(tech.userId).select("fcmTokens").lean().catch(() => null);
        if (user?.fcmTokens) rawTokens.push(...user.fcmTokens);
        const userDeviceDocs = await DeviceToken.find({
          userId: tech.userId,
          isActive: true,
        }).select("fcmToken").lean().catch(() => []);
        userDeviceDocs.forEach((d) => {
          if (d.fcmToken) rawTokens.push(d.fcmToken);
        });
      }
    }

    // 3. De-duplicate and validate
    const tokens = [...new Set(rawTokens)].filter(
      (t) => typeof t === "string" && t.trim().length > 10
    );

    if (!tokens.length) {
      return { success: true, skipped: true, reason: "no_fcm_token" };
    }

    const result = await sendFcmMulticast(tokens, payload);

    // 🧹 Prune tokens FCM rejected as PERMANENTLY invalid
    // DO NOT prune for temporary/config errors (project mismatch, quota, etc.)
    const permanentFailures = (result.failedTokens || [])
      .filter((f) => isPermanentTokenFailure(f.error))
      .map((f) => f.token)
      .filter(Boolean);

    const temporaryFailures = (result.failedTokens || [])
      .filter((f) => isTemporaryTokenFailure(f.error))
      .map((f) => ({ token: f.token, error: f.error }));

    if (permanentFailures.length) {
      await pruneInvalidTokens(recipientId, recipientType, permanentFailures).catch((e) =>
        console.warn(`⚠️ FCM token prune failed for ${recipientId}:`, e.message)
      );
      await Promise.all(permanentFailures.map((t) => deactivateTokenByValue(t))).catch(() => {});
    }

    if (temporaryFailures.length) {
      console.warn(
        `⚠️ FCM temporary/config failures (NOT pruning tokens): ${temporaryFailures.length}/${tokens.length}`,
        temporaryFailures.slice(0, 3).map((f) => f.error)
      );
    }

    return { success: true, ...result, permanentFailures: permanentFailures.length, temporaryFailures: temporaryFailures.length };
  } catch (error) {
    console.error("❌ Push notification error:", error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Send socket notification (real-time)
 */
export const sendSocketNotification = (io, technicianId, event, data) => {
  try {
    if (!io) {
      console.warn("⚠️ Socket.io not initialized");
      return { success: false, message: "Socket.io not available" };
    }

    io.to(SOCKET_ROOMS.TECHNICIAN(technicianId)).emit(event, data);
    console.log(`🔌 Socket notification sent to Technician ${technicianId}:`, event);
    return { success: true, message: "Socket notification sent" };
  } catch (error) {
    console.error("❌ Socket notification error:", error.message);
    return { success: false, error: error.message };
  }
};

/* ============================================================
   🛡 DEDUPE CACHE — closes the "double-fire" match race
   Uses Redis for multi-instance safety with in-memory fallback
   ============================================================ */
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const IN_MEMORY_FALLBACK = new Map();
const FALLBACK_CLEANUP_INTERVAL = 60000;

async function alreadySent(broadcastId, technicianId) {
  if (!broadcastId || !technicianId) return false;
  const key = `dedupe:jobnew:${broadcastId}:${technicianId}`;
  
  // Try Redis first
  if (isRedisAvailable()) {
    try {
      const client = await getRedisClient();
      const result = await client.set(key, '1', { NX: true, EX: Math.ceil(DEDUPE_WINDOW_MS / 1000) });
      return result === null; // null means key already existed
    } catch (err) {
      console.warn('[Dedupe] Redis error, falling back to memory:', err.message);
    }
  }
  
  // In-memory fallback
  if (IN_MEMORY_FALLBACK.has(key)) return true;
  IN_MEMORY_FALLBACK.set(key, Date.now());
  return false;
}

// Fallback cleanup
setInterval(() => {
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  for (const [key, ts] of IN_MEMORY_FALLBACK) {
    if (ts < cutoff) IN_MEMORY_FALLBACK.delete(key);
  }
}, FALLBACK_CLEANUP_INTERVAL).unref?.();

/**
 * Notify a single technician about a new job
 */
export const notifyTechnicianOfNewJob = async (io, technicianId, jobData, broadcast) => {
  try {
    const activation = await checkTechnicianActivation(technicianId);
    if (!activation.isActive) {
      console.log(`⚠️ Skipped job:new for ineligible technician ${technicianId} (${activation.message})`);
      return { success: false, skipped: true, reason: activation.message };
    }

    const techProfile = await TechnicianProfile.findById(technicianId).select("availability.isOnline").lean();
    if (!techProfile?.availability?.isOnline) {
      console.log(`⚠️ Skipped job:new for offline technician ${technicianId}`);
      return { success: false, skipped: true, reason: "technician_offline" };
    }

    const jobDTO = toJobNewDTO(jobData, broadcast);

    if (alreadySent(jobDTO.broadcastId, technicianId)) {
      console.log(`⚠️ Skipped duplicate job:new ${jobDTO.broadcastId} → tech ${technicianId}`);
      return { success: false, skipped: true, reason: "duplicate" };
    }

    // 1️⃣ Send socket notification FIRST (< 5ms hot path)
    let socketResult = { success: false, offline: true, message: "Technician offline — push queued" };
    if (io) {
      const userRoom = SOCKET_ROOMS.USER(technicianId);
      const techRoom = SOCKET_ROOMS.TECHNICIAN(technicianId);

      // Emit to standardized room and legacy room
      io.to(userRoom).emit(SOCKET_EVENTS.JOB_NEW, jobDTO);
      io.to(techRoom).emit(SOCKET_EVENTS.JOB_NEW, jobDTO);
      io.to(userRoom).emit(SOCKET_EVENTS.NOTIFICATION_NEW, {
        id: `job-${jobDTO.bookingId}`,
        type: "JOB_NEW",
        title: "🆕 New Job Available",
        message: `New ${jobDTO.serviceName || "service"} job in your area`,
        bookingId: String(jobDTO.bookingId || ""),
        createdAt: new Date().toISOString(),
      });

      console.log(`⚡ [JOB_NEW EMIT] Dispatched to Tech ${technicianId} (rooms: ${userRoom}, ${techRoom})`);
      socketResult = { success: true, message: "Job alert emitted to live socket" };
    }

    // 2️⃣ Send push notification in background (non-blocking)
    sendPushNotification(technicianId, {
      title: "🆕 New Job Available",
      body: `New ${jobDTO.serviceName || "service"} job in your area`,
      data: {
        type: "new_job",
        bookingId: String(jobDTO.bookingId || ""),
        serviceId: String(jobDTO.serviceId || ""),
        scheduledAt: String(jobDTO.scheduledAt || ""),
      },
    }, { recipientType: "technician" }).catch((err) => {
      console.warn(`⚠️ Background push notification error for tech ${technicianId}:`, err.message);
    });

    return { success: true, socket: socketResult };
  } catch (error) {
    console.error(`❌ Error notifying technician ${technicianId}:`, error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Batch-send push notifications across multiple recipients with a SINGLE DB query.
 */
export const sendPushNotificationBatch = async (recipientIds, payload, options = {}) => {
  if (!recipientIds?.length) return { success: true, count: 0 };
  const recipientType = options.recipientType || "technician";

  try {
    const stringIds = recipientIds.map(String);

    // ⚡ 1 SINGLE BATCH QUERY for all active tokens
    const deviceDocs = await DeviceToken.find({
      userId: { $in: stringIds },
      isActive: true,
    }).select("userId fcmToken").lean().catch(() => []);

    const tokens = [...new Set(deviceDocs.map(d => d.fcmToken).filter(t => typeof t === "string" && t.trim().length > 10))];

    if (!tokens.length) {
      return { success: true, skipped: true, reason: "no_fcm_tokens" };
    }

    const result = await sendFcmMulticast(tokens, payload);
    return { success: true, count: tokens.length, ...result };
  } catch (err) {
    console.warn(`[sendPushNotificationBatch] Error for ${recipientType}s:`, err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Broadcast new job to technicians — Socket FIRST, batch FCM in background
 */
export const broadcastJobToTechnicians = async (io, technicianIds, jobData, broadcastMap) => {
  try {
    const results = {
      socket: [],
    };

    // ⚡ 1. EMIT WEBSOCKETS IMMEDIATELY (Hot path < 10ms)
    await Promise.allSettled(
      technicianIds.map(async (technicianId) => {
        const broadcast = broadcastMap?.get(technicianId?.toString?.() || technicianId);
        const notifyResult = await notifyTechnicianOfNewJob(io, technicianId, jobData, broadcast);
        results.socket.push({ technicianId, ...notifyResult });
      })
    );

    // ⚡ 2. BATCH FCM PUSH IN BACKGROUND (1 Query, Non-blocking)
    const pushPayload = {
      title: "🆕 New Job Available",
      body: `New ${jobData.serviceName || "service"} job in your area`,
      data: {
        type: "new_job",
        bookingId: String(jobData.bookingId || ""),
        serviceId: String(jobData.serviceId || ""),
        scheduledAt: String(jobData.scheduledAt || ""),
      },
    };

    sendPushNotificationBatch(technicianIds, pushPayload, { recipientType: "technician" }).catch((e) =>
      console.warn("[broadcastJobToTechnicians] Background batch push error:", e.message)
    );

    const delivered = technicianIds.length;
    console.log(`✅ [BROADCAST COMPLETED] ${delivered} technicians notified via live Socket + background FCM`);
    return { success: true, results };
  } catch (error) {
    console.error("❌ Broadcast error:", error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Notify customer about job acceptance (Socket + FCM Push + In-App DB)
 */
export const notifyCustomerJobAccepted = async (io, customerProfileId, jobData) => {
  try {
    console.log(`📱 Notifying Customer ${customerProfileId} - Job Accepted`);
    const bookingIdStr = String(jobData.bookingId?._id || jobData.bookingId || "");
    const techName = jobData.technicianName || "A technician";
    const userRoom = SOCKET_ROOMS.USER(customerProfileId);
    const custRoom = SOCKET_ROOMS.CUSTOMER(customerProfileId);

    const notificationPayload = {
      bookingId: bookingIdStr,
      technicianId: jobData.technicianId?.toString?.() || jobData.technicianId,
      status: jobData.status || "accepted",
      technicianName: techName,
      title: "Technician Assigned!",
      message: `${techName} has accepted your booking.`,
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    // 1️⃣ Socket notification FIRST (real-time hot path)
    if (io) {
      io.to(userRoom).emit(SOCKET_EVENTS.BOOKING_ACCEPTED, notificationPayload);
      io.to(userRoom).emit(SOCKET_EVENTS.JOB_ACCEPTED_NOTIFY, notificationPayload);
      io.to(userRoom).emit(SOCKET_EVENTS.NOTIFICATION_NEW, {
        type: "BOOKING_ACCEPTED",
        title: "Technician Assigned!",
        message: `${techName} has accepted your booking.`,
        bookingId: bookingIdStr,
        createdAt: new Date().toISOString(),
      });

      // Legacy room support
      io.to(custRoom).emit(SOCKET_EVENTS.JOB_ACCEPTED_NOTIFY, notificationPayload);
      console.log(`⚡ [BOOKING_ACCEPTED EMIT] Emitted to Customer ${customerProfileId} (rooms: ${userRoom}, ${custRoom})`);
    }

    // 2️⃣ Persistent Notification in MongoDB (Layer A)
    Notification.create({
      recipientId: customerProfileId,
      recipientType: "customer",
      eventType: "BOOKING_ACCEPTED",
      title: "Technician Assigned!",
      body: `${techName} has accepted your booking.`,
      data: {
        bookingId: bookingIdStr,
        technicianId: String(jobData.technicianId || ""),
      },
      category: "booking",
      sourceType: "Booking",
      sourceId: bookingIdStr,
    }).catch((e) => console.warn("Failed to create in-app notification for booking acceptance:", e.message));

    // 3️⃣ FCM Push notification in background
    sendPushNotification(
      customerProfileId,
      {
        title: "Technician Assigned!",
        body: `${techName} has accepted your booking.`,
        data: {
          type: "job_accepted",
          bookingId: bookingIdStr,
        },
      },
      { recipientType: "customer" }
    ).catch((e) => console.warn("Failed to dispatch customer FCM push:", e.message));

    return { success: true, message: "Customer notified via Socket, Push & In-App" };
  } catch (error) {
    console.error("❌ Customer notification error:", error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Notify other technicians that job was taken
 */
export const notifyJobTaken = (io, technicianIds, bookingId) => {
  try {
    if (!io) return { success: false, message: "Socket.io not available" };

    technicianIds.forEach((technicianId) => {
      io.to(SOCKET_ROOMS.TECHNICIAN(technicianId)).emit(SOCKET_EVENTS.JOB_TAKEN, {
        bookingId: String(bookingId),
        message: "This job has been accepted by another technician",
        timestamp: new Date(),
      });
    });

    console.log(`✅ Notified ${technicianIds.length} technicians - Job taken`);
    return { success: true };
  } catch (error) {
    console.error("❌ Job taken notification error:", error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Notify a technician with reliable fallback (Socket -> Push -> SMS).
 */
export const notifyTechnicianWithFallback = async (io, technicianId, payload, critical = false) => {
  try {
    const { event, data, pushTitle, pushBody, smsMessage } = payload;
    let delivered = false;

    // 1️⃣ Try Socket Notification
    if (io) {
      try {
        await new Promise((resolve) => {
          io.to(SOCKET_ROOMS.TECHNICIAN(technicianId)).emit(event, data, () => {
            delivered = true;
            resolve();
          });
          setTimeout(() => {
            if (!delivered) resolve();
          }, 500).unref?.();
        });
        if (delivered) console.log(`✅ [ReliableNotify] Socket delivered to Tech ${technicianId}`);
      } catch (socketErr) {
        console.warn(`🕒 [ReliableNotify] Socket failed for Tech ${technicianId}`);
      }
    }

    if (delivered) return { success: true, via: "socket" };

    // 2️⃣ Fallback to Firebase Push
    await sendPushNotification(
      technicianId,
      {
        title: pushTitle || "RightTouch Update",
        body: pushBody || "You have a new update",
        data: { ...data, type: event },
      },
      { recipientType: "technician" }
    );

    return { success: true, via: "push" };
  } catch (error) {
    console.error("❌ Reliable notification error:", error.message);
    return { success: false, error: error.message };
  }
};
