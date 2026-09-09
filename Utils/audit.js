import AuditLog from "../Schemas/AuditLog.js";

/**
 * ✍️ Write an audit log entry. Never throws — audit failures must not break
 * the primary money flow.
 */
export const writeAuditLog = async ({
  actor = null,
  actorRole = null,
  action = "SYSTEM_ACTION",
  targetType = "System",
  targetId = null,
  before = null,
  after = null,
  reason = null,
  metadata = null,
  session = null,
}) => {
  try {
    const doc = {
      actor,
      actorRole,
      action: action || "SYSTEM_ACTION",
      targetType: targetType || "System",
      targetId,
      before,
      after,
      reason,
      metadata,
    };
    if (session) {
      await AuditLog.create([doc], { session });
    } else {
      await AuditLog.create(doc);
    }
  } catch (err) {
    console.error("[AuditLog] write failed:", err.message);
  }
};
