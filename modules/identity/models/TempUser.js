import mongoose from "mongoose";

const tempUserSchema = new mongoose.Schema(
  {
    identifier: {
      type: String, // email
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["Owner", "Admin", "Customer", "Technician"],
      required: true,
      index: true,
    },
    tempstatus: {
      type: String,
      enum: ["Pending", "Verified", "Expired"],
      default: "Pending",
    },
    termsAndServices: {
      type: Boolean,
      default: false,
    },
    privacyPolicy: {
      type: Boolean,
      default: false,
    },
    termsAndServicesAt: {
      type: Date,
      default: null,
    },
    privacyPolicyAt: {
      type: Date,
      default: null,
    },
    // P2 (Task 6): temporary signup records must auto-expire. Set at
    // creation (24h) and enforced by the application guard in verify even
    // before MongoDB's asynchronous TTL sweeper removes the row.
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);


tempUserSchema.index({ identifier: 1, role: 1 }, { unique: true });

// P2 (Task 6): TTL on expiresAt removes stale signup rows automatically.
// Only TempUser rows carry expiresAt — User collection untouched.
tempUserSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.TempUser ||
  mongoose.model("TempUser", tempUserSchema);
