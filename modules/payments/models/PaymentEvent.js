import mongoose from "mongoose";

const paymentEventSchema = new mongoose.Schema(
  {
    provider: String,
    eventId: { type: String, unique: true },
    bookingId: mongoose.Schema.Types.ObjectId,
    paymentId: mongoose.Schema.Types.ObjectId,
    eventType: String,
    payload: Object,
  },
  { timestamps: true }
);

export default mongoose.models.PaymentEvent || mongoose.model("PaymentEvent", paymentEventSchema);
