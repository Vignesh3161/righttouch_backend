import mongoose from "mongoose";

/**
 * 🛠 TECHNICIAN SKILL REQUEST
 *
 * Tracks requests submitted by technicians to add skills/services
 * (especially when a service is not currently mapped or requires qualification verification).
 * Admins can review, approve (which attaches the skill to the technician profile and
 * optionally enables ZoneServiceMapping), or reject with remarks.
 */
const technicianSkillRequestSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      default: null,
      index: true,
    },

    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      default: null,
      index: true,
    },

    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
      index: true,
    },

    serviceName: {
      type: String,
      trim: true,
      default: null,
    },

    experienceYears: {
      type: Number,
      default: 0,
      min: 0,
      max: 15,
    },

    reason: {
      type: String,
      required: true,
      trim: true,
    },

    documentUrls: [
      {
        type: String,
        trim: true,
      },
    ],

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    adminRemarks: {
      type: String,
      trim: true,
      default: null,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

technicianSkillRequestSchema.index({ technicianId: 1, serviceId: 1, status: 1 });
technicianSkillRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.models.TechnicianSkillRequest ||
  mongoose.model("TechnicianSkillRequest", technicianSkillRequestSchema);
