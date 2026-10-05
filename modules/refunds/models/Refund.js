import mongoose from "mongoose";

const breakdownSchema = new mongoose.Schema(
  {
    basePaise: { type: Number, default: 0, min: 0 },
    gstPaise: { type: Number, default: 0, min: 0 },
    tipPaise: { type: Number, default: 0, min: 0 },
    productPaise: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const refundSchema = new mongoose.Schema(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, required: true },
    bookingType: { type: String, enum: ["product", "service"], default: "service" },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "TechnicianProfile", default: null },

    refundClass: { type: String, enum: ["restitution", "adjudication"], required: true },
    reason: { type: String, required: true },
    faultParty: {
      type: String,
      enum: ["technician", "platform", "customer", "none", "shared"],
      default: "platform",
    },
    sharePct: { type: Number, default: 100, min: 0, max: 100 },

    reportId: { type: mongoose.Schema.Types.ObjectId, ref: "Report", default: null },
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    grossPaise: { type: Number, default: 0, min: 0 },
    breakdown: { type: breakdownSchema, default: () => ({}) },
    materialCostPaise: { type: Number, default: 0, min: 0 },
    netRefundPaise: { type: Number, default: 0, min: 0 },

    clawbackRequiredPaise: { type: Number, default: 0, min: 0 },
    clawbackAppliedPaise: { type: Number, default: 0, min: 0 },
    clawbackFromReservePaise: { type: Number, default: 0, min: 0 },
    clawbackToDuesPaise: { type: Number, default: 0, min: 0 },
    commissionReversedPaise: { type: Number, default: 0, min: 0 },
    mdrLossPaise: { type: Number, default: 0, min: 0 },
    processingFeePaise: { type: Number, default: 0, min: 0 },
    gstRecoverable: { type: Boolean, default: false },
    creditNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditNote", default: null },

    rail: { type: String, enum: ["razorpay_reverse", "razorpayx_payout"], default: "razorpay_reverse" },
    speed: { type: String, enum: ["normal", "optimum"], default: "normal" },
    providerRefundId: { type: String, default: null },
    providerStatus: { type: String, default: null },

    status: {
      type: String,
      enum: [
        "pending_execution",
        "initiated",
        "processed",
        "failed",
        "retrying",
        "manual_review",
        "unrefundable_source",
      ],
      default: "pending_execution",
      required: true,
    },

    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    awaitingApproval: { type: Boolean, default: false },
    idempotencyKey: { type: String, default: null, unique: true, sparse: true },
    ledgerEntryIds: [{ type: mongoose.Schema.Types.ObjectId }],

    createdAt: { type: Date, default: null },
    executedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

refundSchema.index({ paymentId: 1, createdAt: -1 });
refundSchema.index({ status: 1, createdAt: 1 });
refundSchema.index({ providerRefundId: 1 }, { sparse: true, unique: true });
refundSchema.index({ bookingId: 1 });

export default mongoose.models.Refund || mongoose.model("Refund", refundSchema);
