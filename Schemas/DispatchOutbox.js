import mongoose from "mongoose";

/**
 * 📤 DISPATCH OUTBOX — decouples broadcast fan-out from the request/cron thread.
 *
 * Matches the PayoutOutbox pattern already in the stack (no new infra):
 *   1. [matching] enqueue one row per (booking × technician) — bulkWrite,
 *      never awaited inline in the request path.
 *   2. [worker]   bounded-concurrency poller claims rows, calls
 *      notifyTechnicianOfNewJob, marks done, or retries with backoff.
 *   3. Dedupe of live sockets is preserved — the worker calls the same
 *      notifyTechnicianOfNewJob (which owns alreadySent dedupe).
 *
 * Rows stuck in "inflight" beyond the claim TTL are reclaimed by the worker
 * (crash recovery) — delivery is at-least-once, idempotent by design.
 */
const dispatchOutboxSchema = new mongoose.Schema(
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

    kind: {
      type: String,
      enum: ["job_new"],
      default: "job_new",
      required: true,
    },

    // JobBroadcast _id + version — used to build the versioned DTO at send time
    broadcastId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianBroadcast",
      default: null,
    },

    version: {
      type: Number,
      default: 1,
    },

    // Job data snapshot for the DTO (service info, address, amounts — NOT PII)
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

// Poller query: due pending jobs, oldest first
dispatchOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

// Prevent duplicate outbox rows for the same broadcast (re-broadcast cycles).
// This single (unique, partial) index on { bookingId, technicianId, kind }
// also serves the per-booking fan-out audit query — no separate plain index
// is needed (Mongoose warns on duplicate key patterns).
dispatchOutboxSchema.index(
  { bookingId: 1, technicianId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["pending", "inflight"] } } }
);

// TTL: auto-delete completed/failed rows after 24h to prevent unbounded growth
dispatchOutboxSchema.index(
  { completedAt: 1 },
  { expireAfterSeconds: 86400, partialFilterExpression: { status: { $in: ["done", "failed"] } } }
);

export default mongoose.models.DispatchOutbox ||
  mongoose.model("DispatchOutbox", dispatchOutboxSchema);