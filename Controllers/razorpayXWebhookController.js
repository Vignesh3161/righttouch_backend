import crypto from "crypto";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import PayoutOutbox from "../Schemas/PayoutOutbox.js";
import { settlePayoutSuccess, settlePayoutFailure } from "../Utils/withdrawalPayoutEngine.js";

/**
 * 🪝 RAZORPAYX PAYOUT WEBHOOK CONTROLLER
 * Process asynchronous RazorpayX payout events securely.
 */
export const handleRazorpayXWebhook = async (req, res) => {
  try {
    const webhookSecret =
      process.env.RAZORPAYX_WEBHOOK_SECRET || process.env.RAZORPAY_X_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.warn("⚠️ RAZORPAYX_WEBHOOK_SECRET is not configured");
    } else {
      const signature = req.headers["x-razorpay-signature"];
      const rawBody = req.rawBody || JSON.stringify(req.body);

      if (!signature) {
        return res.status(400).json({ success: false, message: "Missing Razorpay signature header" });
      }

      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

      if (signature !== expectedSignature) {
        console.error("❌ Invalid RazorpayX webhook signature");
        return res.status(400).json({ success: false, message: "Invalid webhook signature" });
      }
    }

    const { event, payload } = req.body || {};
    const payoutEntity = payload?.payout?.entity || {};
    const razorpayPayoutId = payoutEntity.id;
    const referenceId = payoutEntity.reference_id;
    const utr = payoutEntity.utr || null;
    const failureReason = payoutEntity.failure_reason || payoutEntity.status_details?.reason || `Payout event: ${event}`;

    if (!referenceId && !razorpayPayoutId) {
      return res.status(400).json({ success: false, message: "Missing payout entity ID or reference_id" });
    }

    // Locate WithdrawalRequest
    let withdrawal = null;
    if (referenceId) {
      withdrawal = await WithdrawalRequest.findById(referenceId);
    }
    if (!withdrawal && razorpayPayoutId) {
      withdrawal = await WithdrawalRequest.findOne({ payoutReference: razorpayPayoutId });
    }

    if (!withdrawal) {
      console.warn(`[RazorpayX Webhook] Withdrawal not found for ref ${referenceId} / payout ${razorpayPayoutId}`);
      return res.status(200).json({ success: true, message: "Webhook acknowledged (record not found)" });
    }

    console.log(`[RazorpayX Webhook] Processing event "${event}" for withdrawal ${withdrawal._id} (${razorpayPayoutId})`);

    switch (event) {
      case "payout.processed": {
        await settlePayoutSuccess({
          withdrawalId: withdrawal._id,
          razorpayPayoutId,
          utr,
          payoutPayload: payoutEntity,
          actor: { userId: null, role: "System/Webhook" },
        });
        break;
      }

      case "payout.failed":
      case "payout.rejected":
      case "payout.reversed":
      case "payout.cancelled": {
        await settlePayoutFailure({
          withdrawalId: withdrawal._id,
          razorpayPayoutId,
          failureReason,
          payoutPayload: payoutEntity,
          actor: { userId: null, role: "System/Webhook" },
        });
        break;
      }

      case "payout.queued":
      case "payout.initiated":
      case "payout.pending":
      case "payout.processing": {
        await PayoutOutbox.updateOne(
          { withdrawalId: withdrawal._id },
          {
            $set: {
              razorpayPayoutId,
              status: "initiated",
              payoutPayload: payoutEntity,
            },
          }
        );
        if (withdrawal.status !== "processing") {
          withdrawal.status = "processing";
          withdrawal.payoutReference = razorpayPayoutId;
          await withdrawal.save();
        }
        break;
      }

      default: {
        console.log(`[RazorpayX Webhook] Unhandled event type: ${event}`);
      }
    }

    return res.status(200).json({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    console.error("❌ Error processing RazorpayX webhook:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
