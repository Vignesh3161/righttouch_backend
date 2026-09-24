import express from "express";
import rateLimit from "express-rate-limit";
import { handleRazorpayXWebhook } from "../Controllers/razorpayXWebhookController.js";

const router = express.Router();

// Throttle junk-HMAC floods before they hit signature verify + DB lookups.
// Generous enough for Razorpay retries, tight enough to blunt abuse.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { ip: false, trustProxy: false },
});

// RazorpayX Payout Webhook Endpoints
router.post("/razorpayx/webhook", webhookLimiter, handleRazorpayXWebhook);
router.post("/payment/webhook/razorpayx", webhookLimiter, handleRazorpayXWebhook);

export default router;
