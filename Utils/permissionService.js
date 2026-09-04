import mongoose from "mongoose";
import Permission from "../Schemas/Permission.js";
import PermissionHistory from "../Schemas/PermissionHistory.js";
import DeviceToken from "../Schemas/DeviceToken.js";
import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

/**
 * 🔐 PERMISSION SERVICE — centralized mobile permission logic (section 23).
 *
 * The backend NEVER requests/grants OS permissions. It only records the state
 * the mobile app reports, validates it, and exposes feature checks (e.g.
 * canUseTechnicianLocation) so call sites don't re-implement the rules.
 *
 * IMPORTANT: a granted permission is NOT backend authorization. JWT auth, role
 * checks, ownership and business rules are still enforced everywhere (section 17).
 */

export const PERMISSION_STATUSES = ["not_requested", "granted", "denied", "restricted"];

// Permission keys allowed per role. Unknown keys are rejected (section 8).
export const ROLE_PERMISSIONS = {
  Technician: ["location", "camera", "notification"],
  Customer: ["notification"],
};

export const ALL_PERMISSION_KEYS = ["location", "camera", "notification", "microphone"];

export const PLATFORMS = ["android", "ios", "web"];

// Statuses that block push delivery (section 20).
const PUSH_BLOCKING_STATUSES = new Set(["denied", "restricted"]);

const normalizeRole = (role) => {
  if (!role) return null;
  const r = String(role).toLowerCase();
  if (r === "technician") return "Technician";
  if (r === "customer") return "Customer";
  if (r === "admin" || r === "owner") return null; // not mobile-permission roles
  return null;
};

const isKnownStatus = (s) => PERMISSION_STATUSES.includes(s);
const isKnownKey = (k) => ALL_PERMISSION_KEYS.includes(k);

/**
 * Parse a permission value (string OR {status, background}) into a normalized
 * { status, backgroundStatus } object. Throws on invalid input.
 */
const parsePermissionValue = (value) => {
  if (typeof value === "boolean") {
    return { status: value ? "granted" : "denied", backgroundStatus: null };
  }
  if (typeof value === "string") {
    if (!isKnownStatus(value)) {
      throw new Error(`Invalid permission status: ${value}`);
    }
    return { status: value, backgroundStatus: null };
  }
  if (value && typeof value === "object") {
    let { status, background, enabled } = value;
    if (typeof status === "boolean") status = status ? "granted" : "denied";
    if (typeof enabled === "boolean") status = enabled ? "granted" : "denied";
    if (typeof background === "boolean") background = background ? "granted" : "denied";

    if (!isKnownStatus(status)) {
      throw new Error(`Invalid permission status: ${status}`);
    }
    let backgroundStatus = null;
    if (background !== undefined) {
      if (!isKnownStatus(background)) {
        throw new Error(`Invalid background permission status: ${background}`);
      }
      backgroundStatus = background;
    }
    return { status, backgroundStatus };
  }
  throw new Error("Permission value must be a string, boolean, or { status, background }");
};

/**
 * Upsert permission state for a single device. Validates role + permission
 * keys + statuses, writes history for transitions, and is idempotent (section 25).
 *
 * @returns {Object} the updated permission document (lean)
 */
export const upsertPermissions = async ({
  userId,
  role,
  deviceId,
  platform,
  appVersion,
  permissions = {},
}) => {
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    const e = new Error("Invalid userId");
    e.statusCode = 400;
    throw e;
  }
  const normRole = normalizeRole(role);
  if (!normRole || !ROLE_PERMISSIONS[normRole]) {
    const e = new Error("Role not supported for mobile permissions");
    e.statusCode = 403;
    throw e;
  }
  if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
    const e = new Error("deviceId is required (multi-device permission tracking)");
    e.statusCode = 400;
    throw e;
  }

  // ── Validate permission keys are allowed for this role (section 8) ──
  const allowedKeys = ROLE_PERMISSIONS[normRole];
  const incoming = Object.keys(permissions || {});
  const unsupported = incoming.filter((k) => !allowedKeys.includes(k));
  if (unsupported.length) {
    const e = new Error(
      `Unsupported permission type(s) for ${normRole}: ${unsupported.join(", ")}`
    );
    e.statusCode = 400;
    e.unsupported = unsupported;
    throw e;
  }

  // ── Validate + normalize each value ──
  const parsed = {};
  for (const key of incoming) {
    try {
      parsed[key] = parsePermissionValue(permissions[key]);
    } catch (err) {
      const e = new Error(`permissions.${key}: ${err.message}`);
      e.statusCode = 400;
      throw e;
    }
  }

  const now = new Date();
  const setFields = { lastSyncedAt: now };
  if (platform) setFields.platform = String(platform).toLowerCase();
  if (appVersion) setFields.appVersion = String(appVersion);

  // ── Load existing doc to diff for history ──
  const existing = await Permission.findOne({ userId, deviceId }).lean();
  const historyWrites = [];

  const buildUpdate = (doc) => {
    for (const key of Object.keys(parsed)) {
      const prev = (doc?.permissions?.[key]) || { status: "not_requested", backgroundStatus: null };
      const next = parsed[key];

      const statusChanged = prev.status !== next.status;
      const bgChanged =
        (prev.backgroundStatus || null) !== (next.backgroundStatus || null);

      if (statusChanged || bgChanged) {
        historyWrites.push({
          userId,
          role: normRole,
          deviceId,
          permission: key,
          oldStatus: prev.status,
          newStatus: next.status,
          scope:
            key === "location" && (bgChanged || next.backgroundStatus)
              ? next.backgroundStatus
                ? "background"
                : "foreground"
              : "foreground",
          platform: setFields.platform || existing?.platform || null,
          appVersion: setFields.appVersion || existing?.appVersion || null,
        });
      }

      setFields[`permissions.${key}.status`] = next.status;
      setFields[`permissions.${key}.updatedAt`] = now;
      if (next.backgroundStatus !== null) {
        setFields[`permissions.${key}.backgroundStatus`] = next.backgroundStatus;
      }
    }
  };

  buildUpdate(existing);

  const doc = await Permission.findOneAndUpdate(
    { userId, deviceId },
    {
      $set: setFields,
      $setOnInsert: {
        userId,
        role: normRole,
        deviceId,
        permissions: {
          location: { status: "not_requested", updatedAt: now },
          camera: { status: "not_requested", updatedAt: now },
          notification: { status: "not_requested", updatedAt: now },
          microphone: { status: "not_requested", updatedAt: now },
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  if (historyWrites.length) {
    await PermissionHistory.insertMany(historyWrites).catch((e) =>
      console.error("[permissionService] history write failed:", e.message)
    );
  }

  return doc;
};

/**
 * Get permission state for a device (or the most-recently-synced device when
 * deviceId is omitted). Returns { deviceId, platform, appVersion, lastSyncedAt,
 * permissions, devices } — `devices` lists all known devices for the user.
 */
export const getPermissions = async ({ userId, role, deviceId }) => {
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    const e = new Error("Invalid userId");
    e.statusCode = 400;
    throw e;
  }
  const normRole = normalizeRole(role);
  if (!normRole) {
    const e = new Error("Role not supported");
    e.statusCode = 403;
    throw e;
  }

  const all = await Permission.find({ userId, role: normRole }).lean();
  if (!all.length) return null;

  let target = null;
  if (deviceId) {
    target = all.find((d) => d.deviceId === deviceId) || null;
  } else {
    target = all.slice().sort((a, b) => (b.lastSyncedAt || 0) - (a.lastSyncedAt || 0))[0];
  }

  return {
    deviceId: target?.deviceId || null,
    platform: target?.platform || null,
    appVersion: target?.appVersion || null,
    lastSyncedAt: target?.lastSyncedAt || null,
    permissions: target?.permissions || {},
    devices: all.map((d) => ({
      deviceId: d.deviceId,
      platform: d.platform,
      appVersion: d.appVersion,
      lastSyncedAt: d.lastSyncedAt,
    })),
  };
};

const statusOf = (doc, permission, requireBackground = false) => {
  const entry = doc?.permissions?.[permission];
  if (!entry) return "not_requested";
  if (requireBackground) {
    return entry.backgroundStatus || entry.status;
  }
  return entry.status;
};

/**
 * Is the permission granted on THIS device? (section 23 helper)
 * Requires deviceId. Returns boolean.
 */
export const isGrantedOnDevice = async ({
  userId,
  role,
  deviceId,
  permission,
  requireBackground = false,
}) => {
  if (!deviceId) return false;
  const doc = await Permission.findOne({ userId, deviceId }).lean();
  return statusOf(doc, permission, requireBackground) === "granted";
};

/**
 * Is the permission granted on ANY device for this user? Cross-device fallback
 * used by the push gate (we don't know which device will receive the push).
 */
export const isGrantedOnAnyDevice = async ({ userId, role, permission, requireBackground = false }) => {
  const normRole = normalizeRole(role);
  if (!normRole) return false;
  const docs = await Permission.find({ userId, role: normRole }).lean();
  return docs.some((d) => statusOf(d, permission, requireBackground) === "granted");
};

/**
 * Feature check: can this technician use location-dependent features on the
 * given device? (section 18/23) Does NOT validate the location payload itself.
 */
export const canUseTechnicianLocation = async ({ userId, deviceId, requireBackground = false }) => {
  return isGrantedOnDevice({
    userId,
    role: "Technician",
    deviceId,
    permission: "location",
    requireBackground,
  });
};

/**
 * Push gate (section 20): is push delivery allowed for this recipient?
 * True only if at least one device has notification permission granted and not
 * in a blocking state. recipientType is "technician"/"customer" (notify() form).
 */
export const hasNotificationPushAllowed = async ({ userId, role }) => {
  const normRole = normalizeRole(role);
  if (!normRole) return false;
  const docs = await Permission.find({ userId, role: normRole }).lean();
  if (!docs.length) return false; // unknown → conservative: don't push until app reports
  return docs.some((d) => {
    const s = statusOf(d, "notification");
    return s === "granted" || s === "not_requested";
  }) && !docs.every((d) => PUSH_BLOCKING_STATUSES.has(statusOf(d, "notification")));
};

/**
 * 📱 Register / refresh an FCM device token. Upserts the DeviceToken record
 * AND keeps User/TechnicianProfile.fcmTokens in sync so legacy push works.
 */
export const registerDeviceToken = async ({
  userId,
  role,
  deviceId,
  platform,
  fcmToken,
  appVersion,
}) => {
  const normRole = normalizeRole(role);
  if (!normRole) {
    const e = new Error("Role not supported for device tokens");
    e.statusCode = 403;
    throw e;
  }
  if (!deviceId || !fcmToken) {
    const e = new Error("deviceId and fcmToken are required");
    e.statusCode = 400;
    throw e;
  }

  await DeviceToken.findOneAndUpdate(
    { userId, deviceId },
    {
      $set: {
        role: normRole,
        fcmToken,
        isActive: true,
        platform: platform ? String(platform).toLowerCase() : undefined,
        appVersion: appVersion || undefined,
        lastSeenAt: new Date(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  // Mirror into legacy token store.
  if (normRole === "Customer") {
    await User.updateOne({ _id: userId }, { $addToSet: { fcmTokens: fcmToken } }).catch(() => {});
  } else {
    await TechnicianProfile.updateOne({ userId }, { $addToSet: { fcmTokens: fcmToken } }).catch(() => {});
  }

  return { success: true };
};

/**
 * Unregister an FCM device token (logout / app uninstall). Deactivates the
 * DeviceToken and removes the token from the legacy store.
 */
export const unregisterDeviceToken = async ({ userId, role, deviceId, fcmToken }) => {
  const normRole = normalizeRole(role);
  if (!normRole) return { success: false };

  if (deviceId) {
    await DeviceToken.findOneAndUpdate({ userId, deviceId }, { $set: { isActive: false } });
  }
  if (fcmToken) {
    await DeviceToken.updateOne({ userId, fcmToken }, { $set: { isActive: false } });
    const $pull = { fcmTokens: fcmToken };
    if (normRole === "Customer") {
      await User.updateOne({ _id: userId }, { $pull });
    } else {
      await TechnicianProfile.updateOne({ userId }, { $pull });
    }
  }
  return { success: true };
};

/** Mark a (now-dead) FCM token as inactive in the DeviceToken store. */
export const deactivateTokenByValue = async (fcmToken) => {
  if (!fcmToken) return;
  await DeviceToken.updateOne({ fcmToken, isActive: true }, { $set: { isActive: false } }).catch(
    () => {}
  );
};

/**
 * Admin: permission summary across all of a user's devices (section 26).
 */
export const getPermissionSummary = async (userId) => {
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    const e = new Error("Invalid userId");
    e.statusCode = 400;
    throw e;
  }
  const docs = await Permission.find({ userId }).lean();
  return {
    userId: String(userId),
    devices: docs.map((d) => ({
      deviceId: d.deviceId,
      role: d.role,
      platform: d.platform,
      appVersion: d.appVersion,
      lastSyncedAt: d.lastSyncedAt,
      permissions: d.permissions,
    })),
  };
};

/**
 * Admin: permission analytics (section 27) — counts of each status per role
 * and permission key.
 */
export const getPermissionAnalytics = async () => {
  const rows = await Permission.aggregate([
    {
      $project: {
        role: 1,
        perms: { $objectToArray: "$permissions" },
      },
    },
    { $unwind: "$perms" },
    {
      $group: {
        _id: { role: "$role", key: "$perms.k", status: "$perms.v.status" },
        count: { $sum: 1 },
      },
    },
  ]);

  const result = { Technician: {}, Customer: {} };
  for (const r of rows) {
    const role = r._id.role;
    const key = r._id.key;
    const status = r._id.status;
    if (!result[role]) result[role] = {};
    if (!result[role][key]) result[role][key] = {};
    result[role][key][status] = r.count;
  }
  return result;
};
