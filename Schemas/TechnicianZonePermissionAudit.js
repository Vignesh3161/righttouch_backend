import mongoose from "mongoose";

/**
 * 🗺 TECHNICIAN ZONE PERMISSION AUDIT
 * Audit log tracking when Admin grants or revokes zone work permissions for a technician.
 */
const technicianZonePermissionAuditSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },
    cityZoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: ["enabled", "disabled"],
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.models.TechnicianZonePermissionAudit ||
  mongoose.model("TechnicianZonePermissionAudit", technicianZonePermissionAuditSchema);
