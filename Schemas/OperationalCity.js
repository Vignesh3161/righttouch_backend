import mongoose from "mongoose";

/**
 * 🏙 OPERATIONAL CITY — the polygons RightTouch actually operates in.
 *
 * A technician is only eligible for ANY broadcast if their current location
 * point-in-polygon tests against an active OperationalCity. This is
 * INDEPENDENT of the per-job 10 km radius: a tech can be inside the polygon
 * but outside a job's radius (normal), or outside the polygon entirely
 * (drove into a non-operational town) — the latter excludes them from ALL
 * matching even if geometrically within 10 km, because support/insurance/
 * pricing don't exist there.
 *
 * Queried via Mongo's $geoIntersects (2dsphere index) — never hand-rolled
 * point-in-polygon in app code.
 */
const operationalCitySchema = new mongoose.Schema(
  {
    cityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "City",
      default: null,
    },

    name: {
      type: String,
      required: true,
      trim: true,
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
  },
  { timestamps: true }
);

operationalCitySchema.index({ polygon: "2dsphere" });
operationalCitySchema.index({ active: 1, updatedAt: -1 });

export default mongoose.models.OperationalCity ||
  mongoose.model("OperationalCity", operationalCitySchema);
