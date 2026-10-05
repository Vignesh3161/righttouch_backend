/**
 * P3 — Device-token request validators (validation seam for device routes).
 *
 * Extracted VERBATIM from the device-route handlers: same status, message,
 * and envelope behavior. Handlers call these before any persistence.
 */
export const validateDeviceRegister = ({ deviceId, fcmToken }) => {
  if (!deviceId || !fcmToken || typeof fcmToken !== "string" || fcmToken.length < 10) {
    const err = new Error("deviceId and valid fcmToken required");
    err.statusCode = 400;
    throw err;
  }
};

export const validateDeviceUnregister = ({ deviceId, fcmToken }) => {
  if (!deviceId && !fcmToken) {
    const err = new Error("deviceId or fcmToken required");
    err.statusCode = 400;
    throw err;
  }
};
