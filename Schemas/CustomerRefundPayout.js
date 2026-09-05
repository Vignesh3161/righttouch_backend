import mongoose from "mongoose";

const customerRefundPayoutSchema = new mongoose.Schema(
  {
    refundId: { type: mongoose.Schema.Types.ObjectId, ref: "Refund", required: true, unique: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    amountPaise: { type: Number, default: 0, min: 0 },
    destination: {
      type: { type: String, enum: ["bank", "vpa"], default: "bank" },
      accountNumber: { type: String, default: null },
      ifscCode: { type: String, default: null },
      accountName: { type: String, default: null },
      vpa: { type: String, default: null },
    },
    nameMatch: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["pending_approval", "approved", "processing", "paid", "failed", "rejected"],
      default: "pending_approval",
    },
    providerPayoutId: { type: String, default: null },
    rail: { type: String, default: "razorpayx_payout" },
    idempotencyKey: { type: String, default: null, unique: true, sparse: true },
    dualApprovedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

customerRefundPayoutSchema.index({ customerId: 1, createdAt: -1 });

export default mongoose.models.CustomerRefundPayout ||
  mongoose.model("CustomerRefundPayout", customerRefundPayoutSchema);
