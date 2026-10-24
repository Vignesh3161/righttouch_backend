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

    // Retention timestamp. expiresAt is BUSINESS state (when the offer is no
    // longer actionable); purgeAt is STORAGE policy. Keeping them separate
    // prevents the TTL monitor from deleting accepted/rejected audit rows.
    purgeAt: {
      type: Date,
    },

    respondedAt: {
      type: Date,
      default: null,
    },

    expiredAt: {
      type: Date,
      default: null,
    },

    expiredReason: {
      type: String,
      default: null,
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

// Feed lookup: technician's live offers ordered by expiry.
jobBroadcastSchema.index({ technicianId: 1, status: 1, expiresAt: 1 });

// Retention TTL. The old index on `expiresAt` MUST be dropped in production
// (it deleted offers/audit rows the moment the business offer expired).
jobBroadcastSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.JobBroadcast || mongoose.model("JobBroadcast", jobBroadcastSchema);
