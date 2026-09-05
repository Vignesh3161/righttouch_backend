import express from "express";
import { Auth } from "../Middleware/Auth.js";
import {
  registerDeviceToken,
  unregisterDeviceToken,
} from "../Utils/permissionService.js";

/**
 * Device-token (FCM) registration, mounted per role:
 *   POST /api/user/device-token        (Customer)
 *   DELETE /api/user/device-token
 *   POST /api/technician/device-token  (Technician)
 *   DELETE /api/technician/device-token
 *
 * Keeps FCM tokens in the separate DeviceToken store (section 14) while also
 * mirroring into the legacy User/TechnicianProfile.fcmTokens arrays so the
 * existing push path keeps working. Notification permission is intentionally
 * NOT managed here — see the permission endpoints.
 */
export const makeDeviceRouter = (allowedRole) => {
  const router = express.Router();

  const registerDeviceHandler = async (req, res) => {
    try {
      const { userId, role } = req.user;
      const { deviceId, platform, fcmToken, appVersion } = req.body || {};

      if (!deviceId || !fcmToken || typeof fcmToken !== "string" || fcmToken.length < 10) {
        return res.status(400).json({ success: false, message: "deviceId and valid fcmToken required", result: {} });
      }

      const result = await registerDeviceToken({ userId, role, deviceId, platform, fcmToken, appVersion });
      return res.json({ success: true, message: "Device token registered", result });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ success: false, message: err.message, result: {} });
    }
  };

  const unregisterDeviceHandler = async (req, res) => {
    try {
      const { userId, role } = req.user;
      const { deviceId, fcmToken } = req.body || {};
      if (!deviceId && !fcmToken) {
        return res.status(400).json({ success: false, message: "deviceId or fcmToken required", result: {} });
      }
      const result = await unregisterDeviceToken({ userId, role, deviceId, fcmToken });
      return res.json({ success: true, message: "Device token removed", result });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ success: false, message: err.message, result: {} });
    }
  };

  const enforceRole = (req, res, next) => {
    if (!req.user || req.user.role !== allowedRole) {
      return res.status(403).json({ success: false, message: `${allowedRole} access only`, result: {} });
    }
    next();
  };

  router.use(enforceRole);

  router.post("/", registerDeviceHandler);
  router.delete("/", unregisterDeviceHandler);

  return router;
};

export default makeDeviceRouter;
