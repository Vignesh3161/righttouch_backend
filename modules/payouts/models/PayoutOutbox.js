import mongoose from "mongoose";

/**
 * 📤 PAYOUT OUTBOX — closes the "payout sent but DB not updated" ordering gap.
 *
 * Flow:
 *   1. [txn] WithdrawalRequest → processing, PayoutOutbox → initiated
 *   2. Razorpay X POST /v1/payouts (X-Payout-Idempotency: idempotencyKey)
 *   3. [txn] success → WithdrawalRequest → paid, ledger debit, Outbox → completed
 *            failure → WithdrawalRequest → approved (retryable), Outbox → failed
 *   4. Reconciliation cron reads { status: initiated } entries older than 5 min
 *      and reconciles against Razorpay GET /v1/payouts/:id
 */
const payoutOutboxSchema = new mongoose.Schema(
  {
    withdrawalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WithdrawalRequest",
      required: true,
      unique: true,
    },

    // Idempotency key sent as X-Payout-Idempotency to Razorpay X
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
    },

    amountPaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      enum: ["initiated", "completed", "failed", "manual_review"],
      default: "initiated",
      index: true,
    },

    razorpayPayoutId: {
      type: String,
      default: null,
    },

    payoutPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    attempts: {
      type: Number,
      default: 0,
    },

    lastError: {
      type: String,
      default: null,
    },

    initiatedAt: {
      type: Date,
      default: Date.now,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Cron query: stuck payouts
payoutOutboxSchema.index({ status: 1, updatedAt: 1 });

export default mongoose.models.PayoutOutbox ||
  mongoose.model("PayoutOutbox", payoutOutboxSchema);