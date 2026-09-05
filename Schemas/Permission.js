import mongoose from "mongoose";

/**
 * 🔐 MOBILE PERMISSION STATE (reusable across roles)
 *
 * One document per (userId, deviceId) — multi-device aware. A user may have
 * several devices, each with its own OS permission state (e.g. Android phone
 * grants notification while a tablet denies it). The backend only stores the
 * state the mobile app reports after the OS permission prompt; it NEVER
 * requests/grants OS permissions itself.
 *
 * `permissions` is a fixed map of all known permission keys. Unknown keys are
 * rejected at the API layer (role-based allow-list), so this single model
 * serves both Technician and Customer without duplicate schemas.
 *
 * `location` supports an optional `backgroundStatus` for platforms that
 * distinguish foreground vs background location (we never assume background is
 * granted just because foreground is).
 */

const PERMISSION_STATUSES = ["not_requested", "granted", "denied", "restricted"];

const permissionEntrySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: PERMISSION_STATUSES,
      default: "not_requested",
    },
    // Only meaningful for `location` (foreground vs background distinction).
    backgroundStatus: {
      type: String,
      enum: PERMISSION_STATUSES,
      default: null,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const permissionStateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Stored exactly as the JWT role (Customer / Technician). Admin/Owner
    // permission management is intentionally kept separate from mobile users.
    role: {
      type: String,
      enum: ["Customer", "Technician"],
      required: true,
    },
    // Device identifier supplied by the mobile app. Required so permission
    // state can differ per device (section 15).
    deviceId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ["android", "ios", "web"],
      lowercase: true,
      trim: true,
      default: null,
    },
    appVersion: {
      type: String,
      trim: true,
      default: null,
    },
    permissions: {
      location: { type: permissionEntrySchema, default: () => ({}) },
      camera: { type: permissionEntrySchema, default: () => ({}) },
      notification: { type: permissionEntrySchema, default: () => ({}) },
      microphone: { type: permissionEntrySchema, default: () => ({}) },
    },
    // When the mobile app last synced permission state for this device.
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// 🔒 Idempotency / single-record-per-device (section 25). Repeated PUTs for
// the same (userId, deviceId) upsert the same document instead of duplicating.
permissionStateSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

export const PERMISSION_STATUSES_ENUM = PERMISSION_STATUSES;

export default mongoose.models.Permission ||
  mongoose.model("Permission", permissionStateSchema);
