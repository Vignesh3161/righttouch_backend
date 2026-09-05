import express from "express";
import rateLimit from "express-rate-limit";
import { Auth } from "../Middleware/Auth.js";
import {
  listMyPayments,
  getMyPaymentDetail,
  getMyPaymentSummary,
  initiatePayment,
  retryMyPayment,
  getReceipt,
  getRefunds,
  declareCashPayment,
} from "../Controllers/customerPaymentController.js";

const router = express.Router();

// Stricter limiter on write endpoints (order/retry/cash). Min 20/min.
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many payment requests, slow down", result: {} },
});

router.get("/", Auth, listMyPayments);
router.get("/summary", Auth, getMyPaymentSummary);
router.get("/:bookingId", Auth, getMyPaymentDetail);
router.get("/:bookingId/receipt", Auth, getReceipt);
router.get("/:bookingId/refunds", Auth, getRefunds);
router.post("/:bookingId/order", Auth, paymentLimiter, initiatePayment);
router.post("/:bookingId/retry", Auth, paymentLimiter, retryMyPayment);
router.post("/:bookingId/cash/declare", Auth, paymentLimiter, declareCashPayment);

export default router;
