import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  getPermissionSummary,
  getPermissionAnalytics,
} from "../Utils/permissionService.js";

/**
 * Admin/Owner visibility into mobile permission state (section 26/27).
 * Mounted at /api/admin/permissions. No device/privacy PII beyond what is
 * needed to debug notification/location issues is exposed.
 */
const router = express.Router();

router.use(Auth, authorizeRoles("Admin", "Owner"));

// GET /api/admin/permissions/analytics — rollup counts per role/permission/status
// (defined BEFORE /:userId so "analytics" isn't captured as a userId)
router.get("/analytics", async (req, res) => {
  try {
    const analytics = await getPermissionAnalytics();
    return res.json({ success: true, result: analytics });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
});

// GET /api/admin/permissions/:userId — per-device permission summary
router.get("/:userId", async (req, res) => {
  try {
    const summary = await getPermissionSummary(req.params.userId);
    return res.json({ success: true, result: summary });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message, result: {} });
  }
});

export default router;
