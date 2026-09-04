import mongoose from "mongoose";

const chargebackSchema = new mongoose.Schema(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, default: null },
    providerDisputeId: { type: String, required: true, unique: true },
    amountPaise: { type: Number, default: 0, min: 0 },
    reasonCode: { type: String, default: null },
    status: {
      type: String,
      enum: ["open", "under_review", "contested", "won", "lost"],
      default: "open",
    },
    evidenceDeadline: { type: Date, default: null },
    evidence: [
      {
        label: { type: String },
        url: { type: String },
        uploadedAt: { type: Date, default: null },
      },
    ],
    feePaise: { type: Number, default: 0, min: 0 },
    faultParty: {
      type: String,
      enum: ["technician", "platform", "customer", "none", "shared"],
      default: "platform",
    },
  },
  { timestamps: true }
);

chargebackSchema.index({ status: 1, evidenceDeadline: 1 });

export default mongoose.models.Chargeback || mongoose.model("Chargeback", chargebackSchema);
