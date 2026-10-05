import mongoose from "mongoose";

/**
 * ⚠️ RECONCILIATION EXCEPTION — any financial inconsistency discovered by the
 * reconciliation jobs (or the guard rails in the payment flow). Surfaced on the
 * admin dashboard as "unreconciled exceptions" and never silently fixed.
 */
const reconciliationExceptionSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      index: true,
    },

    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "warning",
      index: true,
    },

    bookingId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    withdrawalId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    technicianId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    // Free-form details (expected vs actual values etc.)
    details: { type: mongoose.Schema.Types.Mixed, default: null },

    // Dedupe: the same mismatch should not spam the dashboard
    fingerprint: {
      type: String,
      unique: true,
      index: true,
    },

    resolved: {
      type: Boolean,
      default: false,
      index: true,
    },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    resolutionNote: { type: String, default: null },
  },
  { timestamps: true }
);

export default mongoose.models.ReconciliationException ||
  mongoose.model("ReconciliationException", reconciliationExceptionSchema);