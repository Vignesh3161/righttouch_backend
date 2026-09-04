import mongoose from "mongoose";

/**
 * 🗺 POLYGON VERSION & CHANGE HISTORY
 *
 * Tracks every geometry edit for District and CityZone boundary polygons,
 * enabling before/after diff previews and 1-click rollback.
 */
const polygonVersionSchema = new mongoose.Schema(
  {
    entityType: {
      type: String,
      enum: ["DISTRICT", "CITY_ZONE"],
      required: true,
      index: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    version: {
      type: Number,
      required: true,
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
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    changeReason: {
      type: String,
      trim: true,
      required: true,
    },
    impactSummary: {
      affectedTechnicians: { type: Number, default: 0 },
      affectedServices: { type: Number, default: 0 },
      activeJobsCount: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

polygonVersionSchema.index({ entityType: 1, entityId: 1, version: -1 });

export default mongoose.models.PolygonVersion ||
  mongoose.model("PolygonVersion", polygonVersionSchema);
