import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import { ensureCustomer } from "../Utils/ensureCustomer.js";
import {
  createQuoteRequestController,
  updateMyQuoteRequestController,
  listMyQuoteRequestsController,
  getMyQuoteRequestController,
  cancelMyQuoteRequestController,
} from "../Controllers/productQuoteRequestController.js";
import {
  customerListQuotationsController,
  customerGetQuotationController,
  customerViewQuotationController,
  customerAcceptQuotationController,
  customerRejectQuotationController,
} from "../Controllers/quotationController.js";

const router = express.Router();
const requireCustomer = (req, res, next) => {
  try {
    ensureCustomer(req);
    next();
  } catch (e) {
    return res.status(e.statusCode || 403).json({ success: false, message: e.message, result: {} });
  }
};

import {
  getAllProductBooking,
  getProductBookingById,
} from "../Controllers/productBooking.js";

// --- Quote requests (customer) ---
router.post("/product-quote-requests", Auth, requireCustomer, createQuoteRequestController);
router.post("/product-quotes/request", Auth, requireCustomer, createQuoteRequestController);
router.patch("/product-quote-requests/:id", Auth, requireCustomer, updateMyQuoteRequestController);
router.patch("/product-quotes/:id", Auth, requireCustomer, updateMyQuoteRequestController);
router.get("/product-quote-requests", Auth, listMyQuoteRequestsController);
router.get("/product-quotes", Auth, listMyQuoteRequestsController);
router.get("/product-quote-requests/:id", Auth, getMyQuoteRequestController);
router.get("/product-quotes/:id", Auth, getMyQuoteRequestController);
router.post("/product-quote-requests/:id/cancel", Auth, cancelMyQuoteRequestController);

// --- Quotations (customer) ---
router.get("/quotations", Auth, customerListQuotationsController);
router.get("/quotations/:id", Auth, customerGetQuotationController);
router.post("/quotations/:id/view", Auth, customerViewQuotationController);
router.post("/quotations/:id/accept", Auth, requireCustomer, customerAcceptQuotationController);
router.post("/quotations/:id/reject", Auth, requireCustomer, customerRejectQuotationController);
router.post("/quotations/:id/decline", Auth, requireCustomer, customerRejectQuotationController);

// --- Product Bookings (customer) ---
router.get("/product-bookings", Auth, requireCustomer, getAllProductBooking);
router.get("/product-bookings/:id", Auth, requireCustomer, getProductBookingById);

export default router;
