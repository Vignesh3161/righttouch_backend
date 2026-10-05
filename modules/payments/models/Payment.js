import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      required: true,
      unique: true,
    },

    itemType: {
      type: String,
      enum: ["service", "product", "quotation"],
      default: "service",
    },

    paymentType: {
      type: String,
      enum: ["SERVICE", "PRODUCT", "QUOTATION"],
      default: "SERVICE",
    },

    settlementType: {
      type: String,
      enum: ["TECHNICIAN_COMMISSION", "COMPANY_REVENUE"],
      default: "TECHNICIAN_COMMISSION",
    },

    provider: {
      type: String,
      default: "razorpay",
    },

    mode: {
      type: String,
      enum: ["online", "offline", "cash", "bank_transfer", "upi_direct", "cheque", "other"],
      default: "online",
    },

    offlineDetails: {
      transactionReference: String,
      receivedAt: Date,
      recordedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
      notes: String,
    },

    currency: {
      type: String,
      default: "INR",
    },

    providerOrderId: String,
    providerPaymentId: String,
    providerSignature: String,

    // ──────────────────────────────────────────────────────────────
    // 💰 FINANCIAL SNAPSHOT (integer paise) — a pure COPY of the booking
    // snapshot taken at order creation. NEVER recomputed here.
    // ──────────────────────────────────────────────────────────────
    baseAmountPaise: { type: Number, default: 0, min: 0 },
    totalAmountPaise: { type: Number, default: 0, min: 0 },
    commissionPercentage: { type: Number, default: 0, min: 0, max: 100 },
    commissionAmountPaise: { type: Number, default: 0, min: 0 },
    technicianAmountPaise: { type: Number, default: 0, min: 0 },
    gstAmountPaise: { type: Number, default: 0, min: 0 },
    tipAmountPaise: { type: Number, default: 0, min: 0 },
    commissionRuleSource: { type: String, default: null },
    commissionRuleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceCommissionRule",
      default: null,
    },
    calculationVersion: { type: Number, default: 1 },

    // Idempotency of the Payment record itself
    idempotencyKey: {
      type: String,
      default: null,
      index: true,
    },

    // Provider-captured amount in paise — set at success time and compared
    // against totalAmountPaise. Any mismatch flags the payment for review.
    capturedAmountPaise: { type: Number, default: null },

    // ── Additive fields for the customer payment-management surface ──
    // (do not affect commission/settlement/payout math)
    lastAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentAttempt", default: null },
    amountRefundedPaise: { type: Number, default: 0, min: 0 },

    // Legacy rupee mirrors (migration window only; new code writes paise)
    baseAmount: Number,
    serviceAmount: Number,
    gstAmount: Number,
    gstPercentage: Number,
    tipAmount: Number,
    totalAmount: Number,
    commissionAmount: Number,
    technicianAmount: Number,

    status: {
      type: String,
      enum: ["pending", "success", "failed", "refunded", "manual_review"],
      default: "pending",
    },

    failureReason: String,
    verifiedAt: Date,

    // Reconciliation bookkeeping (backstop cron)
    reconciliationAttempts: {
      type: Number,
      default: 0,
    },

    lastReconciliationAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

paymentSchema.index(
  { provider: 1, providerOrderId: 1 },
  { unique: true, partialFilterExpression: { providerOrderId: { $type: "string" } } }
);

paymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $type: "string" } } }
);

// Reconciliation cron + admin summary hot paths
paymentSchema.index({ status: 1, createdAt: 1 });
paymentSchema.index({ status: 1, reconciliationAttempts: 1 });

export default mongoose.models.Payment || mongoose.model("Payment", paymentSchema);