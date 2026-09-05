import { deleteMyAccountInternal } from "../Services/accountService.js";

/**
 * Controller for self account deletion (`DELETE /api/delete-my-account`).
 */
export const deleteMyAccount = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const tokenRole = req.user?.role;

    await deleteMyAccountInternal({ userId, tokenRole });

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
