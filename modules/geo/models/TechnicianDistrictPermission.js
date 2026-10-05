import mongoose from "mongoose";

/**
 * 🗺 TECHNICIAN DISTRICT PERMISSION
 * Stores explicit per-technician district authorization.
 */
const technicianDistrictPermissionSchema = new mongoose.Schema(
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

    permissionType: {
      type: String,
      enum: ["PRIMARY", "ADDITIONAL"],
      default: "ADDITIONAL",
      required: true,
    },

    isEnabled: {
      type: Boolean,
      default: true,
      index: true,
    },

    enabledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    disabledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    enabledAt: {
      type: Date,
      default: Date.now,
    },

    disabledAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound unique index to prevent duplicate permission rows per tech + district
technicianDistrictPermissionSchema.index(
  { technicianId: 1, districtId: 1 },
  { unique: true }
);

technicianDistrictPermissionSchema.index({ technicianId: 1, isEnabled: 1 });

export default mongoose.models.TechnicianDistrictPermission ||
  mongoose.model("TechnicianDistrictPermission", technicianDistrictPermissionSchema);
