import mongoose from "mongoose";

const serviceSchema = new mongoose.Schema(
  {
    // ================= BASIC =================
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },

    serviceName: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
    },

    
    // ================= SERVICE TYPE =================
    serviceType: {
      type: String,
      enum: ["Repair", "Installation", "Maintenance", "Inspection"],
      required: true,
    },

    pricingType: {
      type: String,
      enum: ["fixed", "after_inspection", "per_unit"],
      default: "fixed",
    },

    // ================= PRICING =================
    serviceCost: {
      type: Number,
      required: true,
    },

    minimumVisitCharge: {
      type: Number,
      default: 0,
    },

    serviceDiscountPercentage: {
      type: Number,
      default: 0,
      max: 100,
    },

    discountAmount: {
      type: Number,
      default: 0,
    },

    discountedPrice: {
      type: Number,
      default: 0,
    },

    // ================= TAX =================
    // GST percentage charged ON TOP of the service price (default 0 = not applicable)
    gstPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // ================= COMMISSION =================
    commissionPercentage: {
      type: Number,
      default: 0,
      max: 50,
    },

    commissionAmount: {
      type: Number,
      default: 0,
    },

    technicianAmount: {
      type: Number,
      default: 0,
    },

    // ================= CONTENT FOR FRONTEND =================
    whatIncluded: {
      type: [String],
      default: [],
    },

    whatNotIncluded: {
      type: [String],
      default: [],
    },

    serviceImages: {
      type: [String],
      default: [],
    },

    serviceHighlights: {
      type: [String], // "30-day warranty", "Verified technician"
      default: [],
    },

    serviceWarranty: {
      type: String, // "30 days"
    },

    cancellationPolicy: {
      type: String,
    },

    frequentlyAskedQuestions: {
      type: [String], // Array of Q&A strings or logic if needed, simple strings for now
      default: [],
    },

    supportedBrands: {
      type: [String],
      default: [],
    },

    // ================= TECHNICAL & OPERATIONAL DETAILS =================
    rectifyMethod: {
      type: [String],
      default: [],
    },

    faultReasons: {
      type: [String],
      default: [],
    },

    toolsEquipments: {
      type: [String],
      default: [],
    },

    serviceChecklist: {
      type: [String],
      default: [],
    },

    requiresSpareParts: {
      type: Boolean,
      default: false,
    },

    // ================= TIME & VISIT =================
    duration: {
      type: String, // "60–90 mins"
    },

    siteVisitRequired: {
      type: Boolean,
      default: false,
    },

    // ================= RATING SUMMARY =================
    ratingSummary: {
      averageRating: {
        type: Number,
        default: 0,
      },
      totalRatings: {
        type: Number,
        default: 0,
      },
    },

    // ================= FLAGS =================
    isPopular: {
      type: Boolean,
      default: false,
    },

    isRecommended: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    /**
     * 🎯 ZONE RESTRICTED — when true, the service is ONLY visible and bookable
     * in zones where an active ZoneServiceMapping exists for it (per city zone).
     * When false, the service is available everywhere (no restriction).
     * Admin toggles this per service.
     */
    zoneRestricted: {
      type: Boolean,
      default: false,
    },

    /**
     * 🎯 SERVICE COVERAGE POLYGON (GeoJSON Polygon/MultiPolygon).
     * When set by the admin, this service can ONLY be booked from locations
     * inside the polygon, and ONLY technicians inside the polygon are matched
     * for its jobs. Absent/null → service available everywhere (backward
     * compatible until polygons are seeded).
     */
    coveragePolygon: {
      type: {
        type: String,
        enum: ["Polygon", "MultiPolygon"],
      },
      coordinates: {
        type: [[[Number]]],
      },
    },
  },
  {
    timestamps: true,
  }
);

serviceSchema.index({ coveragePolygon: "2dsphere" });

// ================= AUTO CALCULATIONS =================
serviceSchema.pre("save", function (next) {
  // Discount
  const discountAmount =
    (this.serviceCost * this.serviceDiscountPercentage) / 100;

  this.discountAmount = discountAmount;
  this.discountedPrice = this.serviceCost - discountAmount;

  // Commission
  this.commissionAmount =
    (this.discountedPrice * this.commissionPercentage) / 100;

  this.technicianAmount =
    this.discountedPrice - this.commissionAmount;

  next();
});

export default mongoose.models.Service || mongoose.model("Service", serviceSchema);
