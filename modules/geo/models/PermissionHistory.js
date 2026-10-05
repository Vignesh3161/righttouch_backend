import mongoose from "mongoose";

/**
 * 🕑 PERMISSION CHANGE HISTORY (audit)
 *
 * Immutable append-only log of important permission transitions. Useful for
 * debugging "why did technician X stop getting location / notifications"
 * incidents (section 16).
 *
 * One document per status change. `oldStatus` is null on the very first report.
 */

const permissionHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["Customer", "Technician"],
      required: true,
    },
    deviceId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // Which permission changed: location | camera | notification | microphone
    permission: {
      type: String,
      required: true,
      index: true,
    },
    oldStatus: {
      type: String,
      default: null,
    },
    newStatus: {
      type: String,
      required: true,
    },
    // Optional: background vs foreground location transition detail.
    scope: {
      type: String,
      enum: ["foreground", "background"],
      default: "foreground",
    },
    platform: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    appVersion: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true }
);

permissionHistorySchema.index({ userId: 1, createdAt: -1 });

export default mongoose.models.PermissionHistory ||
  mongoose.model("PermissionHistory", permissionHistorySchema);
