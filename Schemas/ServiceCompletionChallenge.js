import mongoose from "mongoose";

/**
 * 🔐 SERVICE COMPLETION CHALLENGE — customer-confirmed job completion.
 *
 * A technician finishes the work and requests completion confirmation; the
 * backend stores ONLY the HMAC-SHA256 hash of a 4-digit OTP (peppered with
 * COMPLETION_OTP_PEPPER, bound to bookingId+generation) and sends the
 * plaintext code to the customer's verified phone by SMS. The booking may
 * transition to `completed` only after this challenge is atomically
 * consumed by the verification service (Checkpoint C).
 *
 * Lifecycle:
 *   pending_delivery → pending → verified (terminal, consumed)
 *   pending_delivery|pending → expired | locked | cancelled (terminal)
 *
 * - One ACTIVE challenge per booking (partial unique index below).
 * - Resend creates a NEW generation on the same doc (old OTP dead).
 * - Expiry is ALWAYS checked in code at verify time — never trusted to
 *   TTL deletion (MongoDB TTL removal is asynchronous).
 * - `attempts` is cumulative across generations (max 5 per doc);
 *   `resendCount` max 3 per doc. A fresh doc starts a new budget only
 *   after the previous challenge reached a terminal state.
 */
const serviceCompletionChallengeSchema = new mongoose.Schema(
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

    // HMAC-SHA256 hex digest. select:false so routine reads never pull it.
    otpHash: {
      type: String,
      required: true,
      select: false,
    },
    generation: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    status: {
      type: String,
      enum: [
        "pending_delivery",
        "pending",
        "verified",
        "expired",
        "locked",
        "cancelled",
      ],
      required: true,
      default: "pending_delivery",
      index: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    resendCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    verifiedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// 🔒 One ACTIVE challenge per booking. Terminal states (verified/expired/
// locked/cancelled) are excluded so a new episode can start after the
// previous one ended. Concurrent creation attempts collide with E11000 —
// the loser must load the winner's doc instead of creating a second OTP.
serviceCompletionChallengeSchema.index(
  { bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending_delivery", "pending"] },
    },
    name: "uniq_active_completion_challenge_per_booking",
  }
);

// Sweep / monitoring hot paths.
serviceCompletionChallengeSchema.index({ status: 1, expiresAt: 1 });
serviceCompletionChallengeSchema.index({ technicianId: 1, createdAt: -1 });

export default mongoose.models.ServiceCompletionChallenge ||
  mongoose.model("ServiceCompletionChallenge", serviceCompletionChallengeSchema);
