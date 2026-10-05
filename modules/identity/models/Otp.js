import mongoose from "mongoose";

const otpSchema = new mongoose.Schema(
  {
    identifier: {
      type: String, // email or phone
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["Owner", "Admin", "Customer", "Technician"],
      required: true,
      index: true,
    },
    
    otp: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    purpose: {
      type: String,
      enum: ["SIGNUP", "RESET_PASSWORD", "LOGIN"],
      required: true,
    },
  },
  { timestamps: true }
);

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// P2 (Task 5): compound index for the scoped OTP lookup/consume pattern
// (identifier + role + purpose, newest first). Supports verify, resend, and
// signup/login wipe queries. TTL on expiresAt above is kept as-is.
otpSchema.index({ identifier: 1, role: 1, purpose: 1, createdAt: -1 });

export default mongoose.models.Otp || mongoose.model("Otp", otpSchema);
