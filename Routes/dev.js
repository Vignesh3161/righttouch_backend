import express from "express";
import { Auth } from "../Middleware/Auth.js";
import { findEligibleTechniciansForService } from "../Utils/technicianMatching.js";
import { SOCKET_EVENTS } from "../Utils/socketConstants.js";
import { toJobNewDTO } from "../Utils/socketDTO.js";

const router = express.Router();

// 🔒 Dev-only socket routes — locked behind a DEDICATED opt-in flag
// (Socket Analysis B1.6: NODE_ENV alone is not a safe gate — a single
// misconfigured deployment exposes these). Defaults to CLOSED.
const devSocketRoutesEnabled = process.env.ENABLE_DEV_SOCKET_ROUTES === "true";

if (devSocketRoutesEnabled) {

  // @route   POST /api/dev/test-notification
  // @desc    Test 2-Layer Notification (Persistent Mongo + Socket.IO / Redis Adapter)
  // @access  Private (Auth required)
  router.post("/test-notification", Auth, async (req, res) => {
    try {
      const { userId, recipientType, event, title, message, bookingId, metadata } = req.body;
      const targetUserId = userId || req.user?.userId;

      if (!targetUserId) {
        return res.status(400).json({ success: false, message: "userId is required" });
      }

      const { sendAppNotification } = await import("../Services/unifiedNotificationService.js");

      const result = await sendAppNotification({
        userId: targetUserId,
        recipientType: recipientType || (req.user?.role?.toLowerCase() || "customer"),
        technicianProfileId: req.user?.technicianProfileId || null,
        type: event || "TEST_NOTIFICATION",
        title: title || "Test Notification",
        message: message || "Hello from RightTouch 2-Layer Notification System!",
        bookingId: bookingId || `dev-booking-${Date.now()}`,
        metadata: {
          socketEvent: event || "notification:new",
          ...(typeof metadata === "object" ? metadata : {}),
        },
        sendPush: false, // Dev test focuses on Socket + Mongo
        io: req.io,
      });

      return res.status(200).json({
        success: true,
        message: "2-Layer Notification dispatched successfully",
        diagnostic: {
          targetUserId,
          room: `user:${targetUserId}`,
          event: event || "notification:new",
          socketEmitted: result.socketEmitted,
          notification: result.notification,
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // @route   POST /api/dev/test-redis
  // @desc    Test Socket Broadcast (Targets YOU based on your token)
  // @access  Private (Auth required)
  router.post("/test-redis", Auth, (req, res) => {
    try {
        const { event, message } = req.body;

        if (!req.io) {
            return res.status(500).json({ success: false, message: "Socket.io not initialized" });
        }

        // 🔒 SAFETY CHECK: Ensure the user is a technician
        if (req.user?.role !== "Technician" || !req.user?.technicianProfileId) {
            return res.status(403).json({
                success: false,
                message: "Access Denied: This test endpoint is only for logged-in Technicians."
            });
        }

        // ROOM is derived ONLY from the login token
        const targetRoom = `technician_${req.user.technicianProfileId}`;
        const targetEvent = event || SOCKET_EVENTS.JOB_NEW;

        // Build payload through the SAME DTO used by production emitters
        // (Fix #4: dev emits must match the real job:new contract)
        const payload = toJobNewDTO(
            {
                ...(typeof message === "object" && message ? message : {}),
                bookingId: message?.bookingId || "dev-test-booking",
                serviceName: message?.serviceName || "Live Test Notification",
            },
            { _id: `dev-${Date.now()}`, version: 1 }
        );

        // Emit via Socket.io
        req.io.to(targetRoom).emit(targetEvent, payload);
        req.io.to(`user:${req.user.userId}`).emit(targetEvent, payload);

        return res.status(200).json({
            success: true,
            message: "Socket test event emitted",
            details: { room: targetRoom, userRoom: `user:${req.user.userId}`, event: targetEvent, payload }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
  });

  // @route   POST /api/dev/find-techs
  // @desc    Find Eligible Techs for Service & Broadcast
  // @access  Private
  router.post("/find-techs", Auth, async (req, res) => {
    try {
        const { serviceId, message } = req.body;

        if (!serviceId) {
            return res.status(400).json({ success: false, message: "serviceId is required" });
        }

        // 1. Find matches (Live check: Online + Skills + KYC)
        const technicians = await findEligibleTechniciansForService({
            serviceId,
            enableGeo: false
        });

        const technicianIds = technicians.map(t => t._id.toString());

        // 2. Broadcast to them (Fix #4: same DTO + same eligibility path as prod)
        if (req.io && technicianIds.length > 0) {
            const { broadcastJobToTechnicians } = await import("../Utils/sendNotification.js");
            await broadcastJobToTechnicians(req.io, technicianIds, {
                bookingId: message?.bookingId || `dev-${Date.now()}`,
                serviceId,
                serviceName: message?.serviceName || "Dev Test Job",
                description: message?.description || "",
                duration: message?.duration || 60,
                customerName: message?.customerName || "Dev Customer",
                baseAmount: message?.baseAmount || 0,
                address: message?.address || "",
                scheduledAt: message?.scheduledAt || null,
            });
        }

        return res.status(200).json({
            success: true,
            count: technicianIds.length,
            technicians: technicianIds,
            message: `Broadcasted to ${technicianIds.length} technicians`
        });

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
  });
}

export default router;