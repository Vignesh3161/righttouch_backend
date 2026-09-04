import {
  upsertPermissions,
  getPermissions,
} from "../Utils/permissionService.js";

/**
 * Shape a stored permission document into the API response (section 10).
 */
const formatPermissions = (doc) => {
  const perms = doc?.permissions || {};
  const out = {};
  for (const key of Object.keys(perms)) {
    const e = perms[key] || {};
    out[key] = { status: e.status || "not_requested", updatedAt: e.updatedAt || null };
    if (e.backgroundStatus) {
      out[key].backgroundStatus = e.backgroundStatus;
    }
  }
  return out;
};

/**
 * PUT /permissions — store/update permission state for the authenticated user.
 * Identity is taken from the JWT (req.user), NEVER from the request body. If
 * deviceId is omitted the request is rejected (multi-device is mandatory).
 */
export const updatePermissions = async (req, res) => {
  try {
    const { userId, role } = req.user;
    const { platform, appVersion, permissions } = req.body || {};

    if (!permissions || typeof permissions !== "object" || !Object.keys(permissions).length) {
      return res.status(400).json({
        success: false,
        message: "permissions object is required",
        result: {},
      });
    }

    const doc = await upsertPermissions({
      userId,
      role,
      deviceId: req.body.deviceId,
      platform,
      appVersion,
      permissions,
    });

    return res.json({
      success: true,
      message: "Permission state updated",
      result: formatPermissions(doc),
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: err.message || "Failed to update permissions",
      result: {},
    });
  }
};

/**
 * GET /permissions — return the backend's last-known permission state.
 * Optional ?deviceId= to target a specific device. When omitted, returns the
 * most-recently-synced device plus a list of all known devices.
 */
export const getMyPermissions = async (req, res) => {
  try {
    const { userId, role } = req.user;
    const deviceId = req.query.deviceId;

    const result = await getPermissions({ userId, role, deviceId });
    if (!result) {
      return res.json({
        success: true,
        message: "No permission state recorded yet",
        result: { permissions: {}, devices: [] },
      });
    }

    return res.json({
      success: true,
      result: {
        deviceId: result.deviceId,
        platform: result.platform,
        appVersion: result.appVersion,
        lastSyncedAt: result.lastSyncedAt,
        permissions: formatPermissions({ permissions: result.permissions }),
        devices: result.devices,
      },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: err.message || "Failed to fetch permissions",
      result: {},
    });
  }
};
