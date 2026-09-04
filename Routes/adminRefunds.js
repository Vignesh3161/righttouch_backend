import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  adminPreviewRefund,
  adminCreateRefund,
  adminApproveRefund,
  adminRetryRefund,
  adminListRefunds,
  adminCreateCustomerPayoutRefund,
} from "../Controllers/refundController.js";
import {
  adminListComplaints,
  adminGetComplaint,
  adminRejectComplaint,
  adminUpdateComplaintStatus,
  listReportCategories,
} from "../Controllers/complaintController.js";

const router = express.Router();
const admin = authorizeRoles("Admin", "Owner");

router.post("/refunds/preview", Auth, admin, adminPreviewRefund);
router.post("/refunds", Auth, admin, adminCreateRefund);
router.post("/refunds/:id/approve", Auth, admin, adminApproveRefund);
router.post("/refunds/:id/retry", Auth, admin, adminRetryRefund);
router.post("/refunds/:id/customer-payout", Auth, admin, adminCreateCustomerPayoutRefund);
router.get("/refunds", Auth, admin, adminListRefunds);

router.get("/complaints", Auth, admin, adminListComplaints);
router.get("/complaints/:id", Auth, admin, adminGetComplaint);
router.post("/complaints/:id/reject", Auth, admin, adminRejectComplaint);
router.post("/complaints/:id/status", Auth, admin, adminUpdateComplaintStatus);
router.get("/complaints/categories", Auth, admin, listReportCategories);

export default router;
