import mongoose from "mongoose";

/**
 * 🔗 ZONE-SERVICE MAPPING — admin-controlled service approval per city zone.
 *
 * Each document says "service X is approved in zone Y".
 * A booking can only be created for a service in a zone if a mapping exists.
 * A technician can only add a skill for a service if they are registered in
 * a zone where that service is approved.
 */
const zoneServiceMappingSchema = new mongoose.Schema(
  {
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      required: true,
      index: true,
    },

    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
      index: true,
    },

    active: {
      type: Boolean,
      default: true,
    },

    // Zone-specific pricing multiplier (e.g. 1.0 = normal, 1.2 = 20% surge/premium)
    pricingMultiplier: {
      type: Number,
      default: 1.0,
      min: 0.1,
      max: 10.0,
    },

    // Admin-controlled approval metadata
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    approvedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound unique index — one mapping per (zone, service) pair
zoneServiceMappingSchema.index({ zoneId: 1, serviceId: 1 }, { unique: true });
zoneServiceMappingSchema.index({ zoneId: 1, active: 1 });

export default mongoose.models.ZoneServiceMapping ||
  mongoose.model("ZoneServiceMapping", zoneServiceMappingSchema);
