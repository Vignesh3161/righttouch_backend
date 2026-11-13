import mongoose from "mongoose";

/**
 * Telephony call attempt log. A customer no-show claim is only accepted when
 * it references a backend-created call log for the same booking/technician.
 */
const callLogSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      required: true,
      index: true,
    },
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ["twilio", "manual"],
      required: true,
    },
    providerCallId: { type: String, default: null },
    status: {
      type: String,
      enum: [
        "initiating",
        "initiated",
        "ringing",
        "in_progress",
        "completed",
        "busy",
        "no_answer",
        "failed",
        "canceled",
      ],
      default: "initiating",
      index: true,
    },
    direction: { type: String, default: "technician_to_customer" },
    maskedNumber: { type: String, default: null },
    durationSeconds: { type: Number, default: 0, min: 0 },
    verified: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

callLogSchema.index({ bookingId: 1, technicianId: 1, createdAt: -1 });
callLogSchema.index(
  { providerCallId: 1 },
  { unique: true, partialFilterExpression: { providerCallId: { $type: "string" } } }
);

export default mongoose.models.CallLog || mongoose.model("CallLog", callLogSchema);
