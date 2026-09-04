import mongoose from "mongoose";

/**
 * 🗺 SERVICE AVAILABILITY SCHEMA
 *
 * Admin controls whether a service is available at:
 *  - DISTRICT Level (scope = "DISTRICT", cityId = null)
 *  - CITY Level     (scope = "CITY",     cityId = ObjectId)
 *
 * Precedence Rule:
 *   CITY override > DISTRICT default
 *
 * Conflicting configurations are prevented via compound unique index.
 */
const serviceAvailabilitySchema = new mongoose.Schema(
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
      index: true,
    },

    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      required: true,
      index: true,
    },

    cityZoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      default: null,
      index: true,
    },

    cityName: {
      type: String,
      trim: true,
      default: null,
    },

    scope: {
      type: String,
      enum: ["DISTRICT", "CITY", "ZONE"],
      required: true,
      default: "DISTRICT",
    },

    status: {
      type: String,
      enum: ["ENABLED", "DISABLED"],
      required: true,
      default: "ENABLED",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// Compound unique index — prevents duplicate/conflicting configurations for same service + district + cityZoneId + scope
serviceAvailabilitySchema.index(
  { serviceId: 1, districtId: 1, cityZoneId: 1, scope: 1 },
  { unique: true, sparse: true }
);

serviceAvailabilitySchema.index({ serviceId: 1, districtId: 1, status: 1 });
serviceAvailabilitySchema.index({ serviceId: 1, cityZoneId: 1, status: 1 });
serviceAvailabilitySchema.index({ districtId: 1, scope: 1, status: 1 });

export default mongoose.models.ServiceAvailability ||
  mongoose.model("ServiceAvailability", serviceAvailabilitySchema);
