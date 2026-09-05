import mongoose from "mongoose";

/**
 * 🔏 AUDIT LOG — Every manual money/status mutation is traceable to a person.
 * Used by: payment status overrides, commission changes, withdrawal decisions,
 * payout failures, wallet adjustments, settlement events.
 */
const auditLogSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    actorRole: {
      type: String,
      default: null,
    },

    action: {
      type: String,
      required: true,
      index: true,
    },

    targetType: {
      type: String,
      required: true,
      index: true,
    },

    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },

    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    reason: {
      type: String,
      trim: true,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

// Ops-friendly indexes: find all changes to a target, or all logs for an action
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export default mongoose.models.AuditLog ||
  mongoose.model("AuditLog", auditLogSchema);
