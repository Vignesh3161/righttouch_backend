import mongoose from "mongoose";

/**
 * P5 — Persistent authentication session (one row per device login).
 *
 * Security rules:
 * - The raw refresh token is NEVER persisted — only `tokenHash`
 *   (SHA-256 hex of the high-entropy token) is stored and looked up.
 * - Rotation keeps the superseded row (revoked + `replacedBySessionId`)
 *   so presenting it again is detectable as reuse/theft.
 * - A login chain shares one `familyId`; reuse revokes the whole family.
 */
const authSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["Customer", "Technician", "Owner", "Admin"],
      required: true,
    },
    // SHA-256 hex of the refresh token. Unique: each issued token maps to
    // exactly one session row, which is what makes rotation atomic and
    // reuse detectable.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Rotation-chain identifier. A fresh login mints a new familyId; every
    // rotation keeps it, so `revokeSessionFamily` kills exactly one chain.
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokeReason: {
      type: String,
      enum: ["rotated", "logout", "logout_all", "reuse_detected", "security", "deleted"],
      default: null,
    },
    // Rotation/reuse tracing: the replacement session for a rotated row.
    // A revoked row WITH this set means "already rotated" → presenting its
    // token again is reuse. A revoked row WITHOUT it means "logged out".
    replacedBySessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthSession",
      default: null,
    },
    // Optional, server-observed device metadata (never trusted for auth).
    device: {
      userAgent: { type: String, default: null },
      ip: { type: String, default: null },
      deviceId: { type: String, default: null },
      platform: { type: String, default: null },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Expired rows self-delete; revoked rows are kept for the reuse-detection
// window and age out via the same field (revoked rows keep their original
// expiresAt, so no second TTL is needed).
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// logout-all / per-user session scans.
authSessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

export default mongoose.models.AuthSession ||
  mongoose.model("AuthSession", authSessionSchema);
