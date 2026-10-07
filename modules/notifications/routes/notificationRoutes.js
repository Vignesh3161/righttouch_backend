import express from "express";
import { Auth } from "../../../shared/middleware/Auth.js";
import isTechnician from "../../../shared/middleware/isTechnician.js";
import { authorizeRoles } from "../../../shared/middleware/Auth.js";
import {
  listNotifications,
  unreadCount,
  markRead,
  markReadAll,
  markReceived,
  markOpened,
} from "../controllers/notificationController.js";
import {
  getAdminUnreadCounts,
  markAdminItemRead,
} from "../controllers/adminNotificationController.js";

const router = express.Router();

// 🔴 Admin Sidebar Notification Badges endpoints — Admin/Owner only on
// EVERY mount (this router is shared by admin, technician, and user
// prefixes; without an explicit guard any authenticated user could read
// admin queues and mark admin items read). P9 fix.
router.get("/unread-counts", Auth, authorizeRoles("Admin", "Owner"), getAdminUnreadCounts);
router.patch("/mark-read", Auth, authorizeRoles("Admin", "Owner"), markAdminItemRead);

router.get("/", listNotifications);
router.get("/unread-count", unreadCount);
router.patch("/:id/read", markRead);
router.patch("/read-all", markReadAll);
router.post("/:id/received", markReceived);
router.post("/:id/opened", markOpened);

export default router;
