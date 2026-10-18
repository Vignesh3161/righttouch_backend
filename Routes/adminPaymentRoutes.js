import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import { deleteBookingAsAdmin } from "../Controllers/serviceBookController.js";
import {
  recordAdminOfflinePayment,
  updatePaymentStatus,
  resolveManualReviewPayment,
  getPaymentByBooking,
  adminGetProductPaymentsListController,
  adminGetProductPaymentsSummaryController,
} from "../Controllers/paymentController.js";

const router = express.Router();

const adminOnly = authorizeRoles("Admin", "Owner");

// GET /api/admin/payments/product-payments
router.get("/product-payments", Auth, adminOnly, adminGetProductPaymentsListController);

// GET /api/admin/payments/product-payments/summary
router.get("/product-payments/summary", Auth, adminOnly, adminGetProductPaymentsSummaryController);

// POST /api/admin/payments/record-offline (body: { bookingId, paymentMode, transactionReference, amount, notes, receivedAt })
router.post("/record-offline", Auth, adminOnly, recordAdminOfflinePayment);

// POST /api/admin/payments/record-offline/:bookingId
router.post("/record-offline/:bookingId", Auth, adminOnly, recordAdminOfflinePayment);

// PUT /api/admin/payments/:id/status (manual status override with audited reason)
// H8: refuses manual_review sources — those resolve only via :id/resolve-review.
router.put("/:id/status", Auth, adminOnly, updatePaymentStatus);

// H8: PUT /api/admin/payments/:id/resolve-review (manual-review resolution)
// body: { decision: confirm-success|confirm-failed, providerPaymentId?,
//         providerAmountPaise?, reason }
router.put("/:id/resolve-review", Auth, adminOnly, resolveManualReviewPayment);

// GET /api/admin/payments/booking/:bookingId
router.get("/booking/:bookingId", Auth, adminOnly, getPaymentByBooking);

// DELETE /api/admin/payments/booking/:id
router.delete("/booking/:id", Auth, adminOnly, deleteBookingAsAdmin);

export default router;
