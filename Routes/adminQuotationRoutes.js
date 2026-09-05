import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  adminListQuoteRequestsController,
  adminGetQuoteRequestController,
  adminAssignQuoteRequestController,
  adminUpdateQuoteRequestStatusController,
  adminDeleteQuoteRequestController,
} from "../Controllers/productQuoteRequestController.js";
import {
  adminCreateQuotationController,
  adminListQuotationsController,
  adminGetQuotationController,
  adminUpdateQuotationController,
  adminSendQuotationController,
  adminResendQuotationController,
  adminReviseQuotationController,
  adminDeleteQuotationController,
  adminUpdatePaymentStatusController,
} from "../Controllers/quotationController.js";

const router = express.Router();
const adminOnly = authorizeRoles("Admin", "Owner");

import {
  getAllProductBooking,
  getProductBookingById,
  adminCompleteProductBooking,
} from "../Controllers/productBooking.js";
import { recordAdminOfflinePayment } from "../Controllers/paymentController.js";

// --- Quote requests (admin) ---
router.get("/product-quote-requests", Auth, adminOnly, adminListQuoteRequestsController);
router.get("/product-quote-requests/:id", Auth, adminOnly, adminGetQuoteRequestController);
router.post("/product-quote-requests/:id/assign", Auth, adminOnly, adminAssignQuoteRequestController);
router.patch("/product-quote-requests/:id/status", Auth, adminOnly, adminUpdateQuoteRequestStatusController);
router.delete("/product-quote-requests/:id", Auth, adminOnly, adminDeleteQuoteRequestController);

// --- Quotations (admin) ---
router.post("/quotations", Auth, adminOnly, adminCreateQuotationController);
router.get("/quotations", Auth, adminOnly, adminListQuotationsController);
router.get("/quotations/:id", Auth, adminOnly, adminGetQuotationController);
router.patch("/quotations/:id", Auth, adminOnly, adminUpdateQuotationController);
router.put("/quotations/:id", Auth, adminOnly, adminUpdateQuotationController);
router.post("/quotations/:id/send", Auth, adminOnly, adminSendQuotationController);
router.post("/quotations/:id/resend", Auth, adminOnly, adminResendQuotationController);
router.post("/quotations/:id/revise", Auth, adminOnly, adminReviseQuotationController);
router.patch("/quotations/:id/payment-status", Auth, adminOnly, adminUpdatePaymentStatusController);
router.delete("/quotations/:id", Auth, adminOnly, adminDeleteQuotationController);

// --- Product Bookings (admin) ---
router.get("/product-bookings", Auth, adminOnly, getAllProductBooking);
router.get("/product-bookings/:id", Auth, adminOnly, getProductBookingById);
router.put("/product-bookings/:id/complete", Auth, adminOnly, adminCompleteProductBooking);
router.post("/product-bookings/:bookingId/manual-payment", Auth, adminOnly, recordAdminOfflinePayment);

export default router;
