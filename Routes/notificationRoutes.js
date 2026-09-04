import express from "express";
import { Auth } from "../Middleware/Auth.js";
import isTechnician from "../Middleware/isTechnician.js";
import { authorizeRoles } from "../Middleware/Auth.js";
import {
  listNotifications,
  unreadCount,
  markRead,
  markReadAll,
  markReceived,
  markOpened,
} from "../Controllers/notificationController.js";
import {
  getAdminUnreadCounts,
  markAdminItemRead,
} from "../Controllers/adminNotificationController.js";

const router = express.Router();

// 🔴 Admin Sidebar Notification Badges endpoints
router.get("/unread-counts", getAdminUnreadCounts);
router.patch("/mark-read", markAdminItemRead);

router.get("/", listNotifications);
router.get("/unread-count", unreadCount);
router.patch("/:id/read", markRead);
router.patch("/read-all", markReadAll);
router.post("/:id/received", markReceived);
router.post("/:id/opened", markOpened);

export default router;
