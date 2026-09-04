import express from "express";
import { handleRazorpayXWebhook } from "../Controllers/razorpayXWebhookController.js";

const router = express.Router();

// RazorpayX Payout Webhook Endpoints
router.post("/razorpayx/webhook", handleRazorpayXWebhook);
router.post("/payment/webhook/razorpayx", handleRazorpayXWebhook);

export default router;
