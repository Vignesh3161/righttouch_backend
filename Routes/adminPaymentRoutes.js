import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import { deleteBookingAsAdmin } from "../Controllers/serviceBookController.js";
import {
  recordAdminOfflinePayment,
  updatePaymentStatus,
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
router.put("/:id/status", Auth, adminOnly, updatePaymentStatus);

// GET /api/admin/payments/booking/:bookingId
router.get("/booking/:bookingId", Auth, adminOnly, getPaymentByBooking);

// DELETE /api/admin/payments/booking/:id
router.delete("/booking/:id", Auth, adminOnly, deleteBookingAsAdmin);

export default router;
