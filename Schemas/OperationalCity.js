import mongoose from "mongoose";

/**
 * 🏙 OPERATIONAL CITY / DISTRICT — the operational boundaries RightTouch operates in.
 *
 * Configured per district with activation, registration, and job assignment flags.
 * Queried via Mongo's $geoIntersects (2dsphere index).
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
      index: true,
    },

    city: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },

    state: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },

    country: {
      type: String,
      trim: true,
      default: "India",
    },

    code: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
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

    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE", "INVALID", "REVIEW_REQUIRED"],
      default: "ACTIVE",
      index: true,
    },

    statusReason: {
      type: String,
      trim: true,
      default: null,
    },

    version: {
      type: Number,
      default: 1,
    },

    isRegistrationEnabled: {
      type: Boolean,
      default: true,
      index: true,
    },

    isJobEnabled: {
      type: Boolean,
      default: true,
      index: true,
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
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual `isActive` getter/setter for compatibility with District prompt specs
operationalCitySchema.virtual("isActive")
  .get(function () {
    return this.active;
  })
  .set(function (val) {
    this.active = Boolean(val);
  });

operationalCitySchema.index({ polygon: "2dsphere" });
operationalCitySchema.index({ active: 1, isRegistrationEnabled: 1, isJobEnabled: 1, updatedAt: -1 });
operationalCitySchema.index({ name: 1, state: 1 });

export default mongoose.models.OperationalCity ||
  mongoose.model("OperationalCity", operationalCitySchema);
