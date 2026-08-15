import mongoose from "mongoose";

/**
 * 📐 SERVICE COMMISSION RULE — versioned commission defaults per service.
 *
 * Multiple rules may exist for the same service; the active rule is the one with
 * the latest `effectiveFrom` <= now. Historical bookings keep the snapshot stored
 * on the booking itself and are NEVER retroactively altered.
 */
const serviceCommissionRuleSchema = new mongoose.Schema(
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
      index: true,
    },

    commissionPercentage: {
      type: Number,
      required: true,
      min: 0,
      max: 60, // configurable ceiling enforced at controller level too
    },

    effectiveFrom: {
      type: Date,
      required: true,
    },

    setBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    reason: {
      type: String,
      trim: true,
      default: null,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Find the most recent rule for a service quickly
serviceCommissionRuleSchema.index({ serviceId: 1, effectiveFrom: -1 });

export default mongoose.models.ServiceCommissionRule ||
  mongoose.model("ServiceCommissionRule", serviceCommissionRuleSchema);
