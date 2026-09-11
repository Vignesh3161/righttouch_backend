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

    // Dynamic technician service radius in kilometers (Admin configurable, default 10 KM)
    serviceRadiusKm: {
      type: Number,
      default: 10,
      min: 1,
      max: 100,
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

    // 📱 FCM push tokens (multi-device). Registered on app login/foreground;
    // invalid tokens are pruned on FCM error responses (device-not-registered).
    fcmTokens: {
      type: [String],
      default: [],
      index: false,
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
    // Retention reserve (held back from instant payout per the payout arch).
    reserveBalancePaise: { type: Number, default: 0, min: 0 },
    // Outstanding dues recovered from future settlements (penalty / clawback).
    outstandingDuesPaise: { type: Number, default: 0, min: 0 },
    lifetimeEarnedPaise: { type: Number, default: 0, min: 0 },
    lifetimeWithdrawnPaise: { type: Number, default: 0, min: 0 },
    // Optimistic-concurrency guard for all wallet debits.
    walletVersion: { type: Number, default: 0, min: 0 },

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

    /* ──────────────────────────────────────────────────────────────
       💸 AUTO-PAYOUT SETTINGS (per-technician overrides)
       Effective value = tech override ?? global config (GlobalSetting /
       env). Auto-payout fires when availableBalancePaise >= threshold;
       it pays out balance − minimumMaintenancePaise, keeping the
       maintenance floor in the wallet.
    ────────────────────────────────────────────────────────────── */
    payoutSettings: {
      autoPayoutEnabled: { type: Boolean, default: true },
      autoPayoutThresholdPaise: { type: Number, default: 500000, min: 10000 },
      minimumMaintenancePaise: { type: Number, default: 10000, min: 0 },
      preferredPayoutMode: {
        type: String,
        enum: ["UPI", "IMPS", "NEFT"],
        default: "UPI",
      },
    },

    // 🔒 Payout Freeze Control (Admin/Legal/Fraud hold)
    payoutBlocked: {
      type: Boolean,
      default: false,
      index: true,
    },
    payoutBlockedReason: {
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

    // 🏙 OPERATIONAL DISTRICT/CITY ASSIGNMENT
    // Registered primary city/district where the technician is allowed to work by default.
    primaryCityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      default: null,
      index: true,
    },
    primaryDistrictId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      default: null,
      index: true,
    },

    // Additional cities/districts explicitly enabled for this technician by Admin.
    allowedCityIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "OperationalCity",
      },
    ],
    enabledDistrictIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "OperationalCity",
      },
    ],

    // 🏘 CITY ZONES — specific zones Admin allows the technician to work in
    enabledCityZoneIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CityZone",
      },
    ],

    // 📍 CURRENT PHYSICAL LOCATION RESOLUTION (GPS)
    currentDistrictId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      default: null,
      index: true,
    },
    currentCityZoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      default: null,
      index: true,
    },

    // 🏘 CITY ZONE — registered working zone
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

    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    readBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// 2dsphere index for geo queries (nearby technicians)
technicianProfileSchema.index({ location: "2dsphere" });

// Dispatch hot paths: staleness filter + mutex acquisition
technicianProfileSchema.index({ locationUpdatedAt: -1 });

// Auto-payout cron hot path: scan high-balance techs for threshold checks
technicianProfileSchema.index({ availableBalancePaise: 1 });
technicianProfileSchema.index({ isRead: 1, workStatus: 1 });
technicianProfileSchema.index({ allowedCityIds: 1 });

export default mongoose.models.TechnicianProfile ||
  mongoose.model("TechnicianProfile", technicianProfileSchema);
