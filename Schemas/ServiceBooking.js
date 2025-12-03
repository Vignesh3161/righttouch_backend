import mongoose from "mongoose";

const serviceSchema = new mongoose.Schema({
  technicianId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Technician",
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Service",
    required: true,
  },
  status: {
    type: String,
    enum: ["active", "cancelled", "completed"],
    default: "active",
  },
   amount: {
    type: Number,
    required: true,
    min: [0, "Amount must be a positive number"],
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model("ServiceBooking", serviceSchema);
