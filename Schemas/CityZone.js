import mongoose from "mongoose";

/**
 * 🏘 CITY ZONE — granular sub-zones within an OperationalCity.
 *
 * Each zone defines a GeoJSON polygon that sits INSIDE an OperationalCity's
 * polygon. A technician registers for exactly one zone (their working city).
 * A booking is assigned to the zone where the customer's location falls.
 *
 * ZoneServiceMapping documents control which services are approved per zone.
 */
const cityZoneSchema = new mongoose.Schema(
  {
    operationalCityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    zoneCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },

    polygon: {
      type: {
        type: String,
        enum: ["Polygon", "MultiPolygon"],
        required: true,
      },
      coordinates: {
        type: [[[Number]]],
        required: true,
      },
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    description: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true }
);

cityZoneSchema.index({ polygon: "2dsphere" });
cityZoneSchema.index({ operationalCityId: 1, active: 1 });

export default mongoose.models.CityZone ||
  mongoose.model("CityZone", cityZoneSchema);
