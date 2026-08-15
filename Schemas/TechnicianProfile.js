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

const technicianProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // Profile image (optional, not in User)
    profileImage: {
      type: String,
      trim: true,
    },

    // Geo location for technician matching
    location: {
      type: geoPointSchema,
      default: null,
    },

    /* ==========================
       🛠 WORK DETAILS
    ========================== */
    locality: {
      type: String,
      trim: true, // service area / working locality
    },

    address: {
      type: String,
      trim: true,
    },

    city: {
      type: String,
      trim: true,
    },

    state: {
      type: String,
      trim: true,
    },

    pincode: {
      type: String,
      trim: true,
    },

    experienceYears: {
      type: Number,
      default: 0,
      min: 0,
    },

    specialization: {
      type: String,
      trim: true,
    },

    certifications: [
      {
        name: { type: String, trim: true },
        issuer: { type: String, trim: true },
        expiryDate: Date,
      },
    ],

    /* ==========================
       🔧 TECHNICIAN OPERATIONAL DATA
    ========================== */

    skills: [
      {
        serviceId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Service",
          required: true,
        },
        experienceYears: { type: Number, default: 0 },
      },
    ],

    trainingCompleted: {
      type: Boolean,
      default: false,
    },

    workStatus: {
      type: String,
      enum: ["pending", "trained", "approved", "suspended", "deleted"],
      default: "pending",
    },

    availability: {
      isOnline: {
        type: Boolean,
        default: false,
      },
    },

    rating: {
      avg: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },

    walletBalance: {
      type: Number,
      default: 0,
    },

    /* ──────────────────────────────────────────────────────────────
       💰 WALLET MODEL (integer paise) — four explicit balances.
       `walletBalance` above is the legacy rupee mirror of
       availableBalancePaise (maintained by new code + migration).
    ────────────────────────────────────────────────────────────── */
    availableBalancePaise: { type: Number, default: 0, min: 0 },
    reservedBalancePaise: { type: Number, default: 0, min: 0 },
    lifetimeEarnedPaise: { type: Number, default: 0, min: 0 },
    lifetimeWithdrawnPaise: { type: Number, default: 0, min: 0 },

    // Razorpay X (Payout) identifiers – cached to avoid re-creating on every payout
    razorpayContactId: {
      type: String,
      default: null,
      trim: true,
    },

    razorpayFundAccountId: {
      type: String,
      default: null,
      trim: true,
    },

    // Bank / UPI details required for Razorpay X payout
    bankDetails: {
      accountNumber: { type: String, trim: true, default: null },
      ifscCode: { type: String, trim: true, default: null },
      accountName: { type: String, trim: true, default: null },
      upiId: { type: String, trim: true, default: null }, // alternative to bank
    },

    totalJobsCompleted: {
      type: Number,
      default: 0,
    },

    profileComplete: {
      type: Boolean,
      default: false,
    },

    jobRejectCount: {
      type: Number,
      default: 0,
    },

    // Last time matching calculations were performed (for rate limiting)
    lastMatchingAt: {
      type: Date,
      default: null,
    },

    // 📍 Feed cursor: bumped whenever this technician's job feed changes
    // (broadcast created/revived, job taken, broadcast expired). Lets the
    // socket get_jobs poll answer "nothing changed" with a cheap single-field
    // read instead of the full 3-query + populate fetch.
    lastJobsChangeAt: {
      type: Date,
      default: null,
    },

    // ⏱ Last location ping timestamp (staleness gate — a stale ping means
    // the app is backgrounded/killed, not that the tech is standing still).
    // Set on every ping in handleLocationUpdate, no distance gate.
    locationUpdatedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // 🏘 CITY ZONE — technicians are locked to a single zone (their registered city).
    // Set during registration/update from their coordinates.
    cityZoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      default: null,
      index: true,
    },

    // ⚠️ Zone mismatch — set to true when a location ping lands outside the
    // technician's registered cityZone polygon. Cleared when back inside.
    zoneMismatch: {
      type: Boolean,
      default: false,
    },

    // Timestamp of when zone mismatch first started (for admin reporting)
    zoneMismatchSince: {
      type: Date,
      default: null,
    },

    // 🔒 Per-technician dispatch mutex (self-expiring, no Redis needed).
    // Set atomically by findOneAndUpdate before schedule-accept conflict
    // checks; expires after a few seconds so a crashed handler can never
    // deadlock the technician.
    dispatchLockUntil: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// 2dsphere index for geo queries (nearby technicians)
technicianProfileSchema.index({ location: "2dsphere" });

// Dispatch hot paths: staleness filter + mutex acquisition
technicianProfileSchema.index({ locationUpdatedAt: -1 });

export default mongoose.models.TechnicianProfile ||
  mongoose.model("TechnicianProfile", technicianProfileSchema);
