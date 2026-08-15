import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: true,
  },

  productName: {
    type: String,
    required: true,
    trim: true,
  },

  productType: {
    type: String,
    required: true,
    trim: true,
  },


  description: {
    type: String,
    required: true,
  },

  pricingModel: {
    type: String,
    enum: ["fixed", "starting_from", "after_inspection"],
    default: "after_inspection",
  },

  estimatedPriceFrom: Number,
  estimatedPriceTo: Number,

  // GST percentage applied on top of the product price (default 0)
  productGst: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },

  siteInspectionRequired: {
    type: Boolean,
    default: true,
  },

  installationDuration: String,

  usageType: {
    type: String,
    enum: ["Residential", "Commercial", "Industrial"],
  },

  whatIncluded: {
    type: [String],
    default: [],
  },

  whatNotIncluded: {
    type: [String],
    default: [],
  },

  productImages: {
    type: [String],
    default: [], // ✅ important for create-first workflow
  },

  brochurePdf: String,

  technicalSpecifications: {
    type: Map,
    of: String,
  },

  warrantyPeriod: String,


  amcAvailable: {
    type: Boolean,
    default: false,
  },

  amcPricePerYear: Number,

  complianceCertificates: {
    type: [String],
    default: [],
  },

  isActive: {
    type: Boolean,
    default: true,
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

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.models.Product || mongoose.model("Product", productSchema);
