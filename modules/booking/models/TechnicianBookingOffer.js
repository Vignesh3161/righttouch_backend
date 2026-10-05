import mongoose from "mongoose";

/**
 * 🤝 TECHNICIAN BOOKING OFFER — one row per (booking × technician) offer.
 *
 * A booking broadcast to N technicians produces N rows. This is the audit
 * trail behind every accept/decline/expiry decision — feeds acceptance-rate,
 * response-latency and no-show scoring (replaces the bare counters).
 *
 * Lifecycle: offered → (accepted | declined | expired | superseded)
 *   - superseded: another technician claimed the booking first (NOT a
 *     technician behavior signal — keep it distinct from a real decline)
 */
const technicianBookingOfferSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      required: true,
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
    },

    offeredAt: {
      type: Date,
      default: Date.now,
    },

    channel: {
      type: String,
      enum: ["broadcast", "rebroadcast", "direct"],
      default: "broadcast",
    },

    // Distance at offer time (meters) — snapshot for scoring, not live value
    distanceAtOffer: {
      type: Number,
      default: null,
    },

    // Feasibility snapshot taken at offer time — for audit/debug only
    feasibilitySnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    respondedAt: {
      type: Date,
      default: null,
    },

    decision: {
      type: String,
      enum: ["offered", "accepted", "declined", "expired", "superseded"],
      default: "offered",
      index: true,
    },

    responseLatencyMs: {
      type: Number,
      default: null,
    },
  },
  { timestamps: true }
);

// One offer per (booking, technician) — upserted on every broadcast cycle
technicianBookingOfferSchema.index(
  { bookingId: 1, technicianId: 1 },
  { unique: true }
);

// Per-tech funnel queries (acceptance rate, latency, no-show scoring)
technicianBookingOfferSchema.index({
  technicianId: 1,
  decision: 1,
  offeredAt: -1,
});

export default mongoose.models.TechnicianBookingOffer ||
  mongoose.model("TechnicianBookingOffer", technicianBookingOfferSchema);
