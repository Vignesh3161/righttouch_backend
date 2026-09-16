import mongoose from "mongoose";
import Notification from "../Schemas/Notification.js";
import { getIo } from "../Utils/ioAccess.js";
import { SOCKET_ROOMS, SOCKET_EVENTS } from "../Utils/socketConstants.js";
import { sendPushNotification } from "../Utils/sendNotification.js";

/**
 * 🔔 UNIFIED 2-LAYER NOTIFICATION SERVICE
 *
 * Layer A — Persistent Storage (MongoDB Notification Collection):
 *   Always saved permanently so offline users can view notifications upon opening app.
 *
 * Layer B — Real-Time Delivery (Socket.IO + Redis Pub/Sub Adapter):
 *   Delivers instantaneously (< 10ms) across all server instances to user rooms.
 *
 * Background Channel — Push Notifications (Firebase FCM):
 *   Dispatched asynchronously without blocking the event loop or WebSocket emission.
 */
export const sendAppNotification = async ({
  userId,
  recipientType = "customer", // "customer" | "technician" | "admin"
  technicianProfileId = null,
  type = "GENERAL",
  title,
  message,
  bookingId = null,
  metadata = {},
  priority = "normal",
  category = "general",
  sendPush = true,
  io = null,
}) => {
  try {
    if (!userId) {
      console.warn("⚠️ [sendAppNotification] Skipped: userId is required");
      return { success: false, reason: "missing_userId" };
    }

    const recipientObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;

    // ── LAYER A: PERMANENT STORAGE (MongoDB) ─────────────────────────────────
    const notificationDoc = await Notification.create({
      recipientId: recipientObjectId,
      recipientType: recipientType.toLowerCase(),
      eventType: type,
      title: title || "New Notification",
      body: message || "",
      data: {
        bookingId: bookingId ? String(bookingId) : null,
        ...metadata,
      },
      priority,
      category,
      sourceType: bookingId ? "Booking" : "System",
      sourceId: bookingId ? String(bookingId) : null,
    }).catch((err) => {
      console.error("❌ [sendAppNotification] MongoDB save error:", err.message);
      return null;
    });

    const notificationPayload = {
      id: notificationDoc?._id ? String(notificationDoc._id) : `temp-${Date.now()}`,
      notificationId: notificationDoc?._id ? String(notificationDoc._id) : null,
      type,
      title: title || "New Notification",
      message: message || "",
      body: message || "",
      bookingId: bookingId ? String(bookingId) : null,
      metadata: metadata || {},
      read: false,
      createdAt: notificationDoc?.createdAt || new Date().toISOString(),
    };

    // ── LAYER B: REAL-TIME DELIVERY (Socket.IO over Redis Adapter) ────────────
    const socketServer = io || getIo();
    let socketEmitted = false;

    if (socketServer) {
      const userRoom = SOCKET_ROOMS.USER(userId);
      console.log(`📡 [NOTIFICATION EMIT] Room: ${userRoom} | Event: ${SOCKET_EVENTS.NOTIFICATION_NEW}`);

      // Emit to standardized user room
      socketServer.to(userRoom).emit(SOCKET_EVENTS.NOTIFICATION_NEW, notificationPayload);

      // Emit specific event type if mapped (e.g. "booking:accepted", "job:new")
      const specificEvent = metadata?.socketEvent || type?.toLowerCase?.();
      if (specificEvent && specificEvent !== "notification:new") {
        socketServer.to(userRoom).emit(specificEvent, notificationPayload);
      }

      // Backward compatibility with legacy rooms
      if (recipientType.toLowerCase() === "customer") {
        socketServer.to(SOCKET_ROOMS.CUSTOMER(userId)).emit(SOCKET_EVENTS.NOTIFICATION_NEW, notificationPayload);
      } else if (recipientType.toLowerCase() === "technician") {
        if (technicianProfileId) {
          socketServer.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(SOCKET_EVENTS.NOTIFICATION_NEW, notificationPayload);
        }
        socketServer.to(SOCKET_ROOMS.TECHNICIAN(userId)).emit(SOCKET_EVENTS.NOTIFICATION_NEW, notificationPayload);
      }

      socketEmitted = true;
    }

    // ── BACKGROUND PUSH NOTIFICATION (FCM Push — Non-blocking) ───────────────
    if (sendPush) {
      const pushTargetId = (recipientType.toLowerCase() === "technician" && technicianProfileId)
        ? technicianProfileId
        : userId;

      sendPushNotification(
        pushTargetId,
        {
          title: title || "New Notification",
          body: message || "",
          data: {
            type,
            bookingId: bookingId ? String(bookingId) : "",
            ...(typeof metadata === "object" ? metadata : {}),
          },
        },
        { recipientType: recipientType.toLowerCase() }
      ).catch((err) => {
        console.warn(`⚠️ [sendAppNotification] Background FCM push error for ${userId}:`, err.message);
      });
    }

    return {
      success: true,
      notification: notificationPayload,
      socketEmitted,
    };
  } catch (err) {
    console.error("❌ [sendAppNotification] Unexpected failure:", err.message);
    return { success: false, error: err.message };
  }
};

export default {
  sendAppNotification,
};
