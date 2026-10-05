import mongoose from "mongoose";

const bookingPayoutBlockSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "TechnicianProfile", default: null },
    reason: { type: String, default: "complaint_open" },
    reportId: { type: mongoose.Schema.Types.ObjectId, ref: "Report", default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

bookingPayoutBlockSchema.index({ technicianId: 1, releasedAt: 1 });

export default mongoose.models.BookingPayoutBlock ||
  mongoose.model("BookingPayoutBlock", bookingPayoutBlockSchema);
