import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
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

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model("Product", productSchema);
