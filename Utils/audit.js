import AuditLog from "../Schemas/AuditLog.js";

/**
 * ✍️ Write an audit log entry. Never throws — audit failures must not break
 * the primary money flow.
 */
export const writeAuditLog = async ({
  actor = null,
  actorRole = null,
  action,
  targetType,
  targetId = null,
  before = null,
  after = null,
  reason = null,
  metadata = null,
  session = null,
}) => {
  try {
    await AuditLog.create(
      {
        actor,
        actorRole,
        action,
        targetType,
        targetId,
        before,
        after,
        reason,
        metadata,
      },
      session ? { session } : {}
    );
  } catch (err) {
    console.error("[AuditLog] write failed:", err.message);
  }
};
