import mongoose from "mongoose";

/**
 * Opaque, rotating refresh-token sessions.
 *
 * Only the HMAC-SHA256 hash of the raw token is stored. Each login creates a
 * new `familyId` (also emitted as the access-token `sid` claim) so logout can
 * revoke exactly one device. Rotation keeps the same family.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      required: true,
      enum: ["Owner", "Admin", "Customer", "Technician"],
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    familyId: {
      type: String,
      required: true,
      index: true,
    },
    // Snapshot of User.tokenVersion at issue time. Any bump (password change,
    // role change, technician login on another device) invalidates the token.
    tokenVersion: {
      type: Number,
      default: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedReason: {
      type: String,
      default: null,
    },
    replacedBy: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: "",
    },
    ip: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// MongoDB TTL cleanup; expired rows disappear without a cron.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

const RefreshToken =
  mongoose.models.RefreshToken ||
  mongoose.model("RefreshToken", refreshTokenSchema);

export default RefreshToken;
