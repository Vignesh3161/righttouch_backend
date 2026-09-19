// Schemas/JobBroadcast.js
import mongoose from "mongoose";

const jobBroadcastSchema = new mongoose.Schema(
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

    
    expiresAt: {
      type: Date,
    },

    status: {
      type: String,
      enum: ["sent", "accepted", "rejected", "expired", "ACCEPTED"],
      default: "sent",
      index: true,
    },

    // Increments every time the broadcast is re-sent (re-broadcast / revive).
    // Lets clients + the dedupe cache distinguish a re-delivered alert
    // from a genuinely new one.
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  { timestamps: true }
);

// 🚨 Prevent duplicate job sends
jobBroadcastSchema.index({ bookingId: 1, technicianId: 1 }, { unique: true });

// TTL index for automatic cleanup of expired broadcasts
// MongoDB will automatically delete documents where expiresAt < now
jobBroadcastSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.JobBroadcast || mongoose.model("JobBroadcast", jobBroadcastSchema);
