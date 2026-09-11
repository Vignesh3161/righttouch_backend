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
export const emitJobsChanged = (io, technicianProfileId) => {
  try {
    if (!io || !technicianProfileId) return;
    io.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(
      SOCKET_EVENTS.TECH_JOBS_CHANGED,
      { changed: true, at: new Date().toISOString() }
    );
  } catch (err) {
    console.error("emitJobsChanged error:", err.message);
  }
};

/**
 * 🛰 JOB-EXPIRED PUSH
 */
export const emitJobExpired = (io, technicianProfileId, { bookingId, expiresAt, reason } = {}) => {
  try {
    if (!io || !technicianProfileId || !bookingId) return;
    io.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(
      SOCKET_EVENTS.JOB_EXPIRED,
      {
        bookingId: String(bookingId),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : new Date().toISOString(),
        reason: reason || "offer_expired",
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
const INVALID_TOKEN_RE = /not-registered|invalid-argument|unregistered/i;

const pruneInvalidTokens = async (recipientId, recipientType, tokens) => {
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

    // 🧹 Prune tokens FCM rejected as dead
    const invalid = (result.failedTokens || [])
      .filter((f) => INVALID_TOKEN_RE.test(String(f.error)))
      .map((f) => f.token)
      .filter(Boolean);

    if (invalid.length) {
      await pruneInvalidTokens(recipientId, recipientType, invalid).catch((e) =>
        console.warn(`⚠️ FCM token prune failed for ${recipientId}:`, e.message)
      );
      await Promise.all(invalid.map((t) => deactivateTokenByValue(t))).catch(() => {});
      console.log(`🧹 Pruned ${invalid.length} invalid FCM token(s) for ${recipientType} ${recipientId}`);
    }

    return { success: true, ...result };
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
   ============================================================ */
const recentBroadcastCache = new Map();
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

const alreadySent = (broadcastId, technicianId) => {
  if (!broadcastId || !technicianId) return false;
  const key = `${broadcastId}:${technicianId}`;
  if (recentBroadcastCache.has(key)) return true;
  recentBroadcastCache.set(key, Date.now());
  return false;
};

setInterval(() => {
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  for (const [key, ts] of recentBroadcastCache) {
    if (ts < cutoff) recentBroadcastCache.delete(key);
  }
}, 60000).unref?.();

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

    // 1️⃣ Send push notification
    const pushResult = await sendPushNotification(technicianId, {
      title: "🆕 New Job Available",
      body: `New ${jobDTO.serviceName || "service"} job in your area`,
      data: {
        type: "new_job",
        bookingId: String(jobDTO.bookingId || ""),
        serviceId: String(jobDTO.serviceId || ""),
        scheduledAt: String(jobDTO.scheduledAt || ""),
      },
    }, { recipientType: "technician" });

    // 2️⃣ Send socket notification
    let socketResult = { success: false, offline: true, message: "Technician offline — push only" };
    if (io && hasLiveSocket(io, technicianId)) {
      const ACK_TIMEOUT_MS = 10000;
      io.to(SOCKET_ROOMS.TECHNICIAN(technicianId))
        .timeout(ACK_TIMEOUT_MS)
        .emit(SOCKET_EVENTS.JOB_NEW, jobDTO, (err) => {
          recordAck(Boolean(err));
          if (err) {
            console.info(
              `ℹ️ Job alert to Tech ${technicianId} unacknowledged within ${ACK_TIMEOUT_MS}ms (live socket, push already sent)`
            );
          } else {
            console.log(`✅ Job alert acknowledged by Tech ${technicianId}`);
          }
        });

      socketResult = { success: true, message: "Job alert emitted to live socket" };
    } else if (io) {
      console.log(`ℹ️ Job alert to Tech ${technicianId}: no live socket — push-only delivery`);
    }

    return { success: true, push: pushResult, socket: socketResult };
  } catch (error) {
    console.error(`❌ Error notifying technician ${technicianId}:`, error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Broadcast new job to technicians
 */
export const broadcastJobToTechnicians = async (io, technicianIds, jobData, broadcastMap) => {
  try {
    const results = {
      push: [],
      socket: [],
    };

    await Promise.allSettled(
      technicianIds.map(async (technicianId) => {
        const broadcast = broadcastMap?.get(technicianId?.toString?.() || technicianId);
        const notifyResult = await notifyTechnicianOfNewJob(io, technicianId, jobData, broadcast);
        results.push.push({ technicianId, ...notifyResult });
        results.socket.push({ technicianId, ...notifyResult });
      })
    );

    const delivered = technicianIds.length;
    console.log(`✅ Broadcast completed: ${delivered} technicians notified`);
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

    // 1️⃣ Socket notification (real-time)
    if (io) {
      io.to(SOCKET_ROOMS.CUSTOMER(customerProfileId)).emit(SOCKET_EVENTS.JOB_ACCEPTED_NOTIFY, {
        bookingId: bookingIdStr,
        technicianId: jobData.technicianId?.toString?.() || jobData.technicianId,
        status: jobData.status || "accepted",
        technicianName: techName,
        timestamp: new Date(),
      });
    }

    // 2️⃣ FCM Push notification to customer
    await sendPushNotification(
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
    );

    // 3️⃣ In-App Notification Store
    await Notification.create({
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
