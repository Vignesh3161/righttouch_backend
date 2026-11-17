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
const owner = authorizeRoles("Owner");

router.post("/refunds/preview", Auth, owner, adminPreviewRefund);
router.post("/refunds", Auth, owner, adminCreateRefund);
router.post("/refunds/:id/approve", Auth, owner, adminApproveRefund);
router.post("/refunds/:id/retry", Auth, owner, adminRetryRefund);
router.post("/refunds/:id/customer-payout", Auth, owner, adminCreateCustomerPayoutRefund);
router.get("/refunds", Auth, owner, adminListRefunds);

router.get("/complaints/categories", Auth, admin, listReportCategories);
router.get("/complaints", Auth, admin, adminListComplaints);
router.get("/complaints/:id", Auth, admin, adminGetComplaint);
router.post("/complaints/:id/reject", Auth, admin, adminRejectComplaint);
router.post("/complaints/:id/status", Auth, admin, adminUpdateComplaintStatus);

export default router;
