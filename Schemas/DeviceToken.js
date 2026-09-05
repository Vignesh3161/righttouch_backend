import mongoose from "mongoose";

/**
 * 📱 DEVICE TOKENS (FCM) — kept SEPARATE from permission state (section 14).
 *
 * Push-delivery capability = notificationPermission (Permission doc) + fcmToken
 * (this doc). They are independent:
 *   - notification denied  → token may still exist (push withheld at send time)
 *   - notification granted → token can be (re)used for push
 *
 * One active token per (userId, deviceId). Registration upserts; the existing
 * User.fcmTokens / TechnicianProfile.fcmTokens arrays are ALSO kept in sync so
 * the legacy sendPushNotification() path keeps working.
 */

const deviceTokenSchema = new mongoose.Schema(
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
    platform: {
      type: String,
      enum: ["android", "ios", "web"],
      lowercase: true,
      trim: true,
      default: null,
    },
    fcmToken: {
      type: String,
      required: true,
      trim: true,
    },
    // False once FCM reports the token dead, or the app unregisters it.
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    appVersion: {
      type: String,
      trim: true,
      default: null,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// One active registration per device; re-registration replaces the token.
deviceTokenSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

export default mongoose.models.DeviceToken ||
  mongoose.model("DeviceToken", deviceTokenSchema);
