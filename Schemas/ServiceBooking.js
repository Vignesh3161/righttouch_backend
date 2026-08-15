import mongoose from "mongoose";
import { normalizeBookingStatus } from "../Utils/bookingStatus.js";

const geoPointSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
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

const serviceBookingSchema = new mongoose.Schema(
  {

    // 👤 CUSTOMER PROFILE
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // 🛠 SERVICE
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
      index: true,
    },

    // 👨‍🔧 TECHNICIAN (assigned after accept)
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      default: null,
      index: true,
    },

    // 👨‍🔧 TECHNICIAN SNAPSHOT (preserved after deletion)
    technicianSnapshot: {
      name: {
        type: String,
        default: null,
      },
      mobile: {
        type: String,
        default: null,
      },
      deleted: {
        type: Boolean,
        default: false,
      },
    },

    // 💰 PRICE SNAPSHOT
    baseAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // 🧾 TAX SNAPSHOT — GST is charged on top of baseAmount and is a separate
    // liability (remitted to government), never part of technician earnings.
    gstPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    gstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 💝 TIP SNAPSHOT — customer tip. 100% goes to the technician on
    // settlement (added to technicianAmount), collected first by the platform.
    tipAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 📍 ADDRESS SNAPSHOT
    locationType: {
      type: String,
      enum: ["saved", "gps"],
      required: true,
    },

    addressSnapshot: {
      addressLine: String,
      city: String,
      state: String,
      pincode: String,
      name: String,
      phone: String,
      latitude: Number,
      longitude: Number,
    },

    // 📍 ADDRESS (Legacy / Display String)
    address: {
      type: String,
      required: true,
      trim: true,
    },

    // 📍 ADDRESS REFERENCE (for customer details)
    addressId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
      default: null,
      index: true,
    },

    // ⏰ SCHEDULE
    scheduledAt: {
      type: Date,
      index: true,
    },

    // 💳 PAYMENT
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "refunded"],
      default: "pending",
      index: true,
    },

    // ──────────────────────────────────────────────────────────────
    // 💰 IMMUTABLE FINANCIAL SNAPSHOT (paise) — written ONCE at booking
    // creation (or by an authorized admin override on an unpaid booking).
    // NEVER recomputed at payment/settlement/withdrawal time. Never edited
    // by clients. Historical bookings are never retroactively modified.
    // ──────────────────────────────────────────────────────────────
    financialSnapshot: {
      baseAmountPaise: { type: Number, default: 0, min: 0 },
      discountAmountPaise: { type: Number, default: 0, min: 0 },
      totalAmountPaise: { type: Number, default: 0, min: 0 },
      commissionPercentage: { type: Number, default: 0, min: 0, max: 100 },
      commissionAmountPaise: { type: Number, default: 0, min: 0 },
      technicianAmountPaise: { type: Number, default: 0, min: 0 },
      commissionRuleSource: { type: String, default: null },
      commissionRuleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ServiceCommissionRule",
        default: null,
      },
      calculationVersion: { type: Number, default: 1 },
      commissionOverridden: { type: Boolean, default: false },
      financialSnapshotAt: { type: Date, default: null },
      // TAX — GST snapshot (service flow; product flow snapshots its own lines)
      gstPercentage: { type: Number, default: 0, min: 0, max: 100 },
      gstAmountPaise: { type: Number, default: 0, min: 0 },
      tipAmountPaise: { type: Number, default: 0, min: 0 },
    },

    // Paid amount snapshot (paise) — set once when payment succeeds
    paidAmountPaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    paymentProvider: {
      type: String,
      enum: ["razorpay"],
      default: "razorpay",
    },

    paymentOrderId: {
      type: String,
      default: null,
      index: true,
    },

    paymentProviderPaymentId: {
      type: String,
      default: null,
      index: true,
    },

    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    commissionPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    commissionAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // True only when an Admin/Owner explicitly overrode commission for this booking
    // (set via the admin commission-override endpoint). Distinguishes an admin
    // override from the booking-time estimate snapshot.
    commissionOverridden: {
      type: Boolean,
      default: false,
    },

    technicianAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
    },

    // Reconciliation bookkeeping
    reconciliationAttempts: {
      type: Number,
      default: 0,
    },

    lastReconciliationAt: {
      type: Date,
      default: null,
    },

    // ✅ Settlement to technician wallet (idempotent)
    settlementStatus: {
      type: String,
      enum: ["pending", "eligible", "settled"],
      default: "pending",
      index: true,
    },

    settledAt: {
      type: Date,
      default: null,
    },

    // 🕒 BOOKING TYPE
    bookingType: {
      type: String,
      enum: ["instant", "schedule"],
      default: "instant",
      index: true,
    },

    // 📌 STATUS FLOW
    status: {
      type: String,
      enum: [
        "pending",
        "broadcasted",
        "accepted",
        "on_the_way",
        "reached",
        "in_progress",
        "completed",
        "cancelled",
        "expired",
        // Legacy values retained ONLY for the migration window — normalized
        // to canonical values by the pre-save hook. Never used in logic.
        "SEARCHING",
        "ACCEPTED",
        "requested",
      ],
      default: "pending",
      index: true,
    },

    // 👥 ASSIGNMENT STATUS — separate from execution status. Tracks the
    // technician-assignment lifecycle independently of job execution.
    assignmentStatus: {
      type: String,
      enum: ["unassigned", "broadcasted", "assigned", "released"],
      default: "unassigned",
      index: true,
    },

    // ↩️ CANCELLATION STATUS — who cancelled and why (for audit/reports).
    cancellationStatus: {
      type: String,
      enum: [
        "active",
        "customer_cancelled",
        "technician_cancelled",
        "system_cancelled",
      ],
      default: "active",
      index: true,
    },

    // 💳 CANCELLATION FEE COLLECTION STATE — a recorded fee is NOT collected
    // revenue until a real collection mechanism (wallet hold / payment) exists.
    cancellationFeeStatus: {
      type: String,
      enum: ["not_collected", "collected", "waived", "disputed"],
      default: "not_collected",
      index: true,
    },

    // 📅 SCHEDULE TIMEZONE SAFETY — scheduledAt is UTC; local display fields
    // are derived from the configured business timezone and stored for display.
    timezone: {
      type: String,
      default: null,
    },
    scheduledDateLocal: {
      type: String,
      default: null,
    },
    scheduledTimeLocal: {
      type: String,
      default: null,
    },

    // 🕒 INSTANT ETA — estimate only, NOT a guaranteed SLA promise.
    estimatedArrivalAt: {
      type: Date,
      default: null,
    },
    etaGeneratedAt: {
      type: Date,
      default: null,
    },

    // ✅ COMPLETION
    completedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // 📡 BROADCAST VERSION — incremented on every re-broadcast; used for the
    // atomic acceptance claim (status + technicianId + activeBroadcastVersion).
    activeBroadcastVersion: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 🧾 ASSIGNMENT ATTEMPT HISTORY — one entry per technician assignment.
    // Preserved across scheduled re-dispatch (never overwritten).
    assignmentAttempts: [
      {
        technicianId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "TechnicianProfile",
        },
        attemptNumber: { type: Number, min: 1 },
        status: {
          type: String,
          enum: ["assigned", "released", "cancelled", "expired"],
        },
        acceptedAt: { type: Date, default: null },
        releasedAt: { type: Date, default: null },
        releaseReason: { type: String, default: null },
        penaltyTransactionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "WalletTransaction",
          default: null,
        },
        feasibilitySnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    ],

    // 🔒 CRON/WORKER LEASE — multi-instance safety for worker jobs.
    leaseUntil: {
      type: Date,
      default: null,
      index: true,
    },
    leaseOwner: {
      type: String,
      default: null,
    },

    // 🔢 OPTIMISTIC VERSION — bumped on every write; used by idempotent
    // commands and admin overrides.
    version: {
      type: Number,
      default: 0,
    },

    cancelReason: {
      type: String,
      enum: [
        "customer_cancel",
        "technician_cancel",
        "technician_no_action",
        "no_technician_accept",
        "change_of_plans",
        "booked_by_mistake",
        "technician_late",
        "found_better_price",
        "work_already_done",
        "traffic_heavy",
        "vehicle_breakdown",
        "personal_emergency",
        "wrong_service_selected",
        "parts_unavailable",
        "other"
      ],
      default: null,
    },

    cancelledBy: {
      type: String,
      enum: ["customer", "technician", "system"],
      default: null,
    },

    cancellationFee: {
      type: Number,
      default: 0,
    },

    // Integer-paise mirrors (rupee fields above are legacy/display)
    cancellationFeePaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    technicianPenalty: {
      type: Number,
      default: 0,
    },

    // Penalty amount per policy (paise) vs what was actually debited
    // (shortfall remains an outstanding receivable tracked by reconciliation).
    technicianPenaltyPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    technicianPenaltyDebitedPaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    retryCount: {
      type: Number,
      default: 0,
    },

    technicianRejectCount: {
      type: Number,
      default: 0,
    },

    assignedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Optional GeoJSON point for nearby matching
    location: {
      type: geoPointSchema,
      default: null,
    },

    // Broadcasted timestamp for expiry/cleanup
    broadcastedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Search radius in meters (for technician matching)
    radius: {
      type: Number,
      default: 500,
      min: 0,
    },

    workImages: {
      beforeImage: {
        type: String,
        default: null,
      },
      afterImage: {
        type: String,
        default: null,
      },
    },

    faultProblem: {
      type: String,
      trim: true,
      default: null,
    },

    // 🚨 NO-SHOW SAFETY
    // Set when cron detects technician didn't start within 30 min of scheduledAt
    noShowAt: {
      type: Date,
      default: null,
    },

    // 🔔 REMINDER FLAGS (prevent duplicate cron reminders)
    remindersSent: {
      h24: { type: Boolean, default: false },
      h1: { type: Boolean, default: false },
      min15: { type: Boolean, default: false },
      enforceOTW: { type: Boolean, default: false },
      // Scheduled-job escalation ladder (technician did not start travel)
      escalate25: { type: Boolean, default: false },
      escalate15: { type: Boolean, default: false },
      escalate10: { type: Boolean, default: false },
    },

    enforcementAlertAt: {
      type: Date,
      default: null,
      index: true,
    },

    // 🕒 SEARCH & TIMEOUT TRACKING
    broadcastStartedAt: {
      type: Date,
      default: null,
      index: true,
    },

    autoCancelAt: {
      type: Date,
      default: null,
      index: true,
    },

    // 🏘 CITY ZONE — resolved at booking time from customer coordinates.
    // Used for zone-based service availability and analytics.
    cityZoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// Helpful index for technician dashboard
serviceBookingSchema.index({ technicianId: 1, status: 1 });

// Settlement/reconciliation hot paths
serviceBookingSchema.index({ paymentStatus: 1, settlementStatus: 1 });
serviceBookingSchema.index({ settlementStatus: 1, status: 1, paymentStatus: 1 });

// 2dsphere index for geo queries (optional, but required when using $near for bookings)
serviceBookingSchema.index({ location: "2dsphere" });

// 🚀 PRODUCTION SCALE INDEXES for enforcement and reminders
serviceBookingSchema.index({ status: 1, bookingType: 1, "remindersSent.enforceOTW": 1, scheduledAt: 1 });
serviceBookingSchema.index({ status: 1, bookingType: 1, "remindersSent.enforceOTW": 1, enforcementAlertAt: 1 });
serviceBookingSchema.index({ status: 1, "remindersSent.h24": 1, scheduledAt: 1 });
serviceBookingSchema.index({ status: 1, "remindersSent.h1": 1, scheduledAt: 1 });
serviceBookingSchema.index({ status: 1, "remindersSent.min15": 1, scheduledAt: 1 });
serviceBookingSchema.index({ status: 1, technicianId: 1, autoCancelAt: 1 });

// Worker lease / expiry hot path
serviceBookingSchema.index({ leaseUntil: 1, status: 1 });

// ── NORMALIZATION HOOK ────────────────────────────────────────────────────
// Legacy statuses (ACCEPTED / SEARCHING / requested) are normalized to the
// canonical vocabulary before every save. Business logic may then rely on the
// canonical values exclusively.
serviceBookingSchema.pre("save", function (next) {
  if (this.status) {
    this.status = normalizeBookingStatus(this.status);
  }
  if (!this.assignmentStatus) this.assignmentStatus = "unassigned";
  if (!this.cancellationStatus) this.cancellationStatus = "active";
  if (!this.cancellationFeeStatus) this.cancellationFeeStatus = "not_collected";
  next();
});

export default mongoose.models.ServiceBooking || mongoose.model("ServiceBooking", serviceBookingSchema);
