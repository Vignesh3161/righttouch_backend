import mongoose from "mongoose";

const reserveHoldSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, required: true },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "TechnicianProfile", required: true },
    amountPaise: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["held", "frozen", "released", "consumed"],
      default: "held",
    },
    frozenReason: { type: String, default: null },
    reportId: { type: mongoose.Schema.Types.ObjectId, ref: "Report", default: null },
    releaseAt: { type: Date, default: null },
    consumedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Refund", default: null },
  },
  { timestamps: true }
);

reserveHoldSchema.index({ bookingId: 1, status: 1 });
reserveHoldSchema.index({ technicianId: 1, status: 1 });

export default mongoose.models.ReserveHold || mongoose.model("ReserveHold", reserveHoldSchema);
