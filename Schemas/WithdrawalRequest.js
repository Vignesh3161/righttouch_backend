import mongoose from "mongoose";

const withdrawalRequestSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    // Integer paise (primary financial field)
    amountPaise: {
      type: Number,
      default: null,
      min: 0,
    },

    status: {
      type: String,
      enum: [
        "pending",
        "requested",
        "approved",
        "rejected",
        "paid",
        "cancelled",
        "processing",
        "failed",
        "manual_review",
      ],
      default: "pending",
      index: true,
    },

    requestedAt: {
      type: Date,
      default: Date.now,
    },
    //sk

    approvedAt: {
      type: Date,
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    paidAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    decidedAt: {
      type: Date,
      default: null,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    //sk

    adminNote: {
      type: String,
      default: null,
      trim: true,
    },

    decisionNote: {
      type: String,
      default: null,
      trim: true,
    },

    payoutProvider: {
      type: String,
      default: null,
      trim: true,
    },

    payoutReference: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    walletTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WalletTransaction",
      default: null,
      index: true,
    },

    payoutOutboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PayoutOutbox",
      default: null,
    },
  },
  { timestamps: true }
);
//sk
// Prevent duplicate pending/requested requests
withdrawalRequestSchema.index(
  //sk
  { technicianId: 1, status: 1 },
  { 
    unique: true, 
    partialFilterExpression: { 
      status: { $in: ["pending", "requested"] } 
    } 
  }
);

// Admin list/summary hot paths (status filters + date ranges)
withdrawalRequestSchema.index({ status: 1, createdAt: 1 });

// Admin list with no status filter sorts by createdAt alone (S12)
withdrawalRequestSchema.index({ createdAt: -1 });

export default mongoose.models.WithdrawalRequest ||
  mongoose.model("WithdrawalRequest", withdrawalRequestSchema);

