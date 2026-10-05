import mongoose from "mongoose";

/**
 * 🔧 GLOBAL SETTINGS — singleton key-value store for admin-governed platform
 * policies. Settings are read at request time (no cache) so admin changes
 * take effect immediately.
 *
 * Usage: key = "technician.reacceptPenaltyPercent", value = number (0-100).
 */
const globalSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // Audit trail — who last changed this setting
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedByRole: {
      type: String,
      enum: ["Admin", "Owner"],
      default: null,
    },
    lastUpdatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const GlobalSetting = mongoose.model("GlobalSetting", globalSettingSchema);

export default GlobalSetting;