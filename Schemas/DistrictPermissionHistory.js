import mongoose from "mongoose";

/**
 * 📜 TECHNICIAN DISTRICT PERMISSION HISTORY AUDIT LOG
 *
 * Tracks every addition, removal, activation, or revocation of district-level
 * work permissions for technicians with full audit accountability.
 */
const districtPermissionHistorySchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },
    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: ["GRANT", "REVOKE", "ENABLE", "DISABLE"],
      required: true,
    },
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      required: true,
    },
    effectiveFrom: {
      type: Date,
      default: Date.now,
    },
    effectiveTo: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

districtPermissionHistorySchema.index({ technicianId: 1, districtId: 1, createdAt: -1 });

export default mongoose.models.DistrictPermissionHistory ||
  mongoose.model("DistrictPermissionHistory", districtPermissionHistorySchema);
