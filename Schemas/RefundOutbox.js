import mongoose from "mongoose";

const refundOutboxSchema = new mongoose.Schema(
  {
    refundId: { type: mongoose.Schema.Types.ObjectId, ref: "Refund", required: true, unique: true },
    status: {
      type: String,
      enum: ["new", "processing", "done", "failed"],
      default: "new",
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    nextAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

refundOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

export default mongoose.models.RefundOutbox || mongoose.model("RefundOutbox", refundOutboxSchema);
