import mongoose from "mongoose";

/**
 * 📤 BOOKING OUTBOX — booking-level domain events (broadcast trigger, etc.).
 *
 * Complements DispatchOutbox (per technician×booking fan-out) with booking-
 * level events written in the SAME transaction as the booking itself:
 *
 *   BOOKING_CREATED  → consumed by a worker that runs matching + broadcast,
 *                      guaranteeing the broadcast never happens before the
 *                      booking transaction commits (and retrying on failure).
 *
 * Rows are at-least-once: consumers claim atomically, recheck the aggregate
 * state, and mark done. Crash recovery via the inflight claim TTL.
 */
const bookingOutboxSchema = new mongoose.Schema(
  {
    aggregateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      required: true,
      index: true,
    },

    eventType: {
      type: String,
      enum: ["booking_created"],
      required: true,
    },

    // Exactly-once: worker dedupes on this before processing.
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
    },

    // Aggregate version at emit time (optimistic concurrency)
    version: {
      type: Number,
      default: 1,
    },

    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    status: {
      type: String,
      enum: ["pending", "inflight", "done", "failed"],
      default: "pending",
      index: true,
    },

    attempts: {
      type: Number,
      default: 0,
    },

    maxAttempts: {
      type: Number,
      default: 6,
    },

    lastError: {
      type: String,
      default: null,
    },

    nextAttemptAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    claimedAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

bookingOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export default mongoose.models.BookingOutbox ||
  mongoose.model("BookingOutbox", bookingOutboxSchema);