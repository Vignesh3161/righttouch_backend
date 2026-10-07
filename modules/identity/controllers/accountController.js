import { deleteMyAccountInternal } from "../services/accountService.js";
import { emitSecurityEvent } from "../utils/securityEvents.js";
import { getIo } from "../../../shared/utils/ioAccess.js";
import { revokeSocketsForUser } from "../../../shared/utils/socketSessionControl.js";

/**
 * Controller for self account deletion (`DELETE /api/delete-my-account`).
 */
export const deleteMyAccount = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const tokenRole = req.user?.role;

    await deleteMyAccountInternal({ userId, tokenRole });

    // P9: kill live sockets (DB sessions are purged in the service).
    revokeSocketsForUser(getIo(), userId);

    // P9: account deletion ends all sessions — high-value signal.
    emitSecurityEvent({ actor: userId || null, actorRole: tokenRole || null, action: "AUTH_ACCOUNT_DELETED" });

    return res.status(200).json({
      success: true,
      message: "Account deleted successfully",
      result: {},
    });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: err.message || "Failed to delete account",
      result: { reason: err.message || "An error occurred" },
    });
  }
};
