import mongoose from "mongoose";

const geoPointSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: function (v) {
          return (
            Array.isArray(v) &&
            v.length === 2 &&
            typeof v[0] === "number" &&
            Number.isFinite(v[0]) &&
            typeof v[1] === "number" &&
            Number.isFinite(v[1])
          );
        },
        message: "location.coordinates must be [longitude, latitude]",
      },
    },
  },
  { _id: false }
);

/**
 * 📍 TECHNICIAN LOCATION HISTORY SCHEMA
 * Stores historical GPS location pings with spatial index and 30-day TTL cleanup policy.
 */
const technicianLocationHistorySchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },

    location: {
      type: geoPointSchema,
      required: true,
    },

    timestamp: {
      type: Date,
      default: Date.now,
    },

    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      default: null,
      index: true,
    },

    cityZoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      default: null,
      index: true,
    },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      default: null,
      index: true,
    },

    source: {
      type: String,
      enum: ["socket", "http", "job_status_update"],
      default: "http",
    },
  },
  { timestamps: true }
);

// 2dsphere spatial index for historical spatial queries
technicianLocationHistorySchema.index({ location: "2dsphere" });

// Compound query index for technician location timeline
technicianLocationHistorySchema.index({ technicianId: 1, timestamp: -1 });

// TTL retention cleanup policy (30 days = 2,592,000 seconds)
technicianLocationHistorySchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });

export default mongoose.models.TechnicianLocationHistory ||
  mongoose.model("TechnicianLocationHistory", technicianLocationHistorySchema);
