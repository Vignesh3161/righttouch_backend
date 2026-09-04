import { SOCKET_EVENTS, SOCKET_ROOMS } from "./socketConstants.js";
import { toJobNewDTO } from "./socketDTO.js";
import { checkTechnicianActivation } from "./technicianActivation.js";
import { recordAck } from "./socketMetrics.js";
import { sendFcmMulticast } from "./firebase.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import User from "../Schemas/User.js";
import { deactivateTokenByValue } from "./permissionService.js";

/**
 * 📢 NOTIFICATION UTILITY
 * Handles push notifications, SMS, and real-time socket notifications
 */

/**
 * 🔌 LIVE SOCKET PRESENCE (O(1), synchronous)
 * Returns true if the technician currently has at least one connected socket
 * in their private room. Uses the adapter's local room registry so it works
 * with both the in-memory adapter and the Redis ClusterAdapter (which also
 * tracks local rooms).
 *
 * This is the production-grade gate for ACK-waiting emits: we must NEVER run
 * the `.timeout()` ack machinery for an offline technician — that is what
 * produced the misleading "Job alert ... timed out (No ACK)" warnings and,
 * under concurrent broadcasts, wasted ack timers. Offline delivery is the
 * push channel's job (durable fallback), not a socket timeout.
 */
export const hasLiveSocket = (io, technicianId) => {
  try {
    if (!io || !technicianId) return false;
    const room = SOCKET_ROOMS.TECHNICIAN(technicianId);
    const nsp = io.of?.("/") || io;
    const roomSockets = nsp?.adapter?.rooms?.get(room);
    return Boolean(roomSockets && roomSockets.size > 0);
  } catch {
    // Unknown adapter state — be conservative and treat as offline. The push
    // channel remains the durable delivery path, so nothing is lost.
    return false;
  }
};

/**
 * 🛰 JOBS-CHANGED PUSH (Socket Analysis — anti-polling fix)
 * Emits `technician:jobs_changed` to a technician's room whenever their job
 * feed changes (broadcast created/revived, job taken, expired, cancelled,
 * completed). The client should treat this as "refetch your jobs once" —
 * which eliminates the continuous get_jobs polling loop entirely.
 * Fire-and-forget: never throws.
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
 * 🛰 JOB-EXPIRED PUSH — tells a technician their offer on a booking just died
 * (broadcast expired: no_technician_accept, OTW timeout, travel no-show) so
 * the client drops the card instantly instead of waiting for a refetch.
 * Fire-and-forget: never throws.
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
 * Send push notification via FCM (real delivery — was a log-only stub).
 * @param {String} recipientId - TechnicianProfile _id (default) or User _id
 * @param {Object} payload - { title, body, data }
 * @param {Object} [options] - { recipientType: "technician" | "customer" }
 * @returns {Object} result
 */
const INVALID_TOKEN_RE = /not-registered|invalid-argument|unregistered/i;

const pruneInvalidTokens = async (recipientId, recipientType, tokens) => {
  if (!tokens.length) return;
  const $pull = { fcmTokens: { $in: tokens } };
  if (recipientType === "customer") {
    await User.updateOne({ _id: recipientId }, { $pull });
  } else {
    await TechnicianProfile.updateOne({ _id: recipientId }, { $pull });
  }
};

export const sendPushNotification = async (recipientId, payload, options = {}) => {
  const recipientType = options.recipientType === "customer" ? "customer" : "technician";
  try {
    // Pick up the recipient's registered FCM tokens (multi-device array).
    let tokens = [];
    if (recipientType === "customer") {
      const user = await User.findById(recipientId).select("fcmTokens").lean();
      tokens = user?.fcmTokens || [];
    } else {
      const tech = await TechnicianProfile.findById(recipientId).select("fcmTokens").lean();
      tokens = tech?.fcmTokens || [];
    }
    tokens = (tokens || []).filter((t) => typeof t === "string" && t.length > 10);
    if (!tokens.length) {
      return { success: true, skipped: true, reason: "no_fcm_token" };
    }

    const result = await sendFcmMulticast(tokens, payload);

    // 🧹 Prune tokens FCM rejected as dead (device-not-registered / malformed).
    const invalid = (result.failedTokens || [])
      .filter((f) => INVALID_TOKEN_RE.test(String(f.error)))
      .map((f) => f.token)
      .filter(Boolean);
    if (invalid.length) {
      await pruneInvalidTokens(recipientId, recipientType, invalid).catch((e) =>
        console.warn(`⚠️ FCM token prune failed for ${recipientId}:`, e.message)
      );
      // Keep the DeviceToken store consistent (section 14): mark dead tokens inactive.
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
 * @param {Object} io - Socket.io instance
 * @param {String} technicianId - Technician profile ID
 * @param {String} event - Socket event name
 * @param {Object} data - Event data
 */
export const sendSocketNotification = (io, technicianId, event, data) => {
  try {
    if (!io) {
      console.warn("⚠️ Socket.io not initialized");
      return { success: false, message: "Socket.io not available" };
    }

    // Emit to specific technician room
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
   (Concurrent-Risks §3.3): two concurrent path triggers for the
   same broadcast must produce exactly ONE job:new per technician.
   In-memory Map is correct for the single-instance deployment.
   When the Redis adapter is enabled, switch to SETNX for
   multi-instance safety.
   ============================================================ */
const recentBroadcastCache = new Map(); // `${broadcastId}:${technicianId}` -> timestamp
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
 * @param {Object} io - Socket.io instance
 * @param {String} technicianId - Technician profile ID
 * @param {Object} jobData - Job data (see Utils/socketDTO.js toJobNewDTO)
 * @param {Object} [broadcast] - JobBroadcast doc (for broadcastId + version)
 */
export const notifyTechnicianOfNewJob = async (io, technicianId, jobData, broadcast) => {
  try {
    // 🔒 Eligibility re-check IMMEDIATELY before emit (Socket Analysis B1.5):
    // a technician suspended/revoked mid-session must not receive job alerts,
    // even though their socket is still connected with frozen JWT claims.
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

    // 🛡 Server-side dedupe (Concurrent-Risks §3.3)
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
        bookingId: jobDTO.bookingId,
        serviceId: jobDTO.serviceId,
        scheduledAt: jobDTO.scheduledAt,
      },
    });

    // 2️⃣ Send socket notification — ONLY when the technician is actually
    //    connected. Offline techs skip the ack machinery entirely (no held
    //    10s timers, no misleading "No ACK" warning); their durable channel
    //    is the push notification already sent above, and they catch up via
    //    broadcastPendingJobsToTechnician when they come back online.
    let socketResult = { success: false, offline: true, message: "Technician offline — push only" };
    if (io && hasLiveSocket(io, technicianId)) {
      const ACK_TIMEOUT_MS = 10000;
      io.to(SOCKET_ROOMS.TECHNICIAN(technicianId))
        .timeout(ACK_TIMEOUT_MS)
        .emit(SOCKET_EVENTS.JOB_NEW, jobDTO, (err) => {
          recordAck(Boolean(err));
          if (err) {
            // Delivery telemetry only — NOT an error. The push notification
            // is already in flight (durable channel) and the client can also
            // refetch via technician:jobs_changed / get_jobs, so an
            // unacknowledged alert is never a lost job.
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
 * @param {Object} io - Socket.io instance (optional)
 * @param {Array} technicianIds - Array of technician profile IDs
 * @param {Object} jobData - Job broadcast data
 * @param {Object} [broadcastMap] - Optional Map(technicianId -> broadcast doc)
 */
export const broadcastJobToTechnicians = async (io, technicianIds, jobData, broadcastMap) => {
  try {
    const results = {
      push: [],
      socket: [],
    };

    // Parallel broadcast — never block the other 80 on the 20 slow/dead sockets
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
 * Notify customer about job acceptance
 * @param {String} customerProfileId - Customer profile ID
 * @param {Object} jobData - Job acceptance data
 */
export const notifyCustomerJobAccepted = async (io, customerProfileId, jobData) => {
  try {
    console.log(`📱 Notifying Customer ${customerProfileId} - Job Accepted`);

    // Socket notification (real-time)
    if (io) {
      io.to(SOCKET_ROOMS.CUSTOMER(customerProfileId)).emit(SOCKET_EVENTS.JOB_ACCEPTED_NOTIFY, {
        bookingId: jobData.bookingId?.toString?.() || jobData.bookingId,
        technicianId: jobData.technicianId?.toString?.() || jobData.technicianId,
        status: jobData.status || "accepted",
        timestamp: new Date(),
      });
    }

    // TODO: Push notification to customer (FCM)
    // TODO: SMS/WhatsApp notification if needed

    return { success: true, message: "Customer notified" };
  } catch (error) {
    console.error("❌ Customer notification error:", error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Notify other technicians that job was taken
 * @param {Array} technicianIds - Array of technician IDs to notify
 * @param {String} bookingId - Booking ID that was accepted
 */
export const notifyJobTaken = (io, technicianIds, bookingId) => {
  try {
    if (!io) return { success: false, message: "Socket.io not available" };

    technicianIds.forEach((technicianId) => {
      io.to(SOCKET_ROOMS.TECHNICIAN(technicianId)).emit(SOCKET_EVENTS.JOB_TAKEN, {
        bookingId,
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
 * USED FOR BEST-EFFORT events (travel reminders, alerts): the 10s ACK
 * timer is intentionally DROPPED here so slow/offline clients don't pile
 * up held timers (Socket Analysis B2.3).
 */
export const notifyTechnicianWithFallback = async (io, technicianId, payload, critical = false) => {
  try {
    const { event, data, pushTitle, pushBody, smsMessage } = payload;
    let delivered = false;

    // 1️⃣ Try Socket Notification (no ACK timeout held — best effort)
    if (io) {
      try {
        await new Promise((resolve, reject) => {
          io.to(SOCKET_ROOMS.TECHNICIAN(technicianId)).emit(event, data, () => {
            delivered = true;
            resolve();
          });
          // Best-effort: if the room has no connected socket for this tech,
          // resolve immediately so we fall through to push.
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

    // 2️⃣ Fallback to Firebase Push (Free & Supports Custom Text)
    await sendPushNotification(technicianId, {
      title: pushTitle || "RightTouch Update",
      body: pushBody || "You have a new update",
      data: { ...data, type: event }
    });

    return { success: true, via: "push" };
  } catch (error) {
    console.error("❌ Reliable notification error:", error.message);
    return { success: false, error: error.message };
  }
};