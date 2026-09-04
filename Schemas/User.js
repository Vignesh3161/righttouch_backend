import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["Customer", "Technician", "Owner", "Admin"],
      required: true,
      index: true,
    },

    // Optional email (unique if present)
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      // Allow standard email OR anonymized 'deleted_' email
      validate: {
        validator: function (v) {
          return /^\S+@\S+\.\S+$/.test(v) || v.startsWith("deleted_");
        },
        message: "Invalid email",
      },
    },


    fname: {
      type: String,
      trim: true,
    },

    lname: {
      type: String,
      trim: true,
    },

    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
    },

    mobileNumber: {
      type: String,
      unique: true,
      required: true,
      // Allow 10 digits OR anonymized 'deleted_' number
      validate: {
        validator: function (v) {
          return /^[0-9]{10}$/.test(v) || v.startsWith("deleted_");
        },
        message: "Invalid mobile number",
      },
    },

    password: {
      type: String,
      required: false, // OTP-only flow
      select: false,
    },

    status: {
      type: String,
      enum: ["Active", "Inactive", "Blocked", "Deleted"],
      default: "Active",
    },

    profileComplete: {
      type: Boolean,
      default: false,
    },

    lastLoginAt: Date,

    // 📱 FCM push tokens (multi-device). Registered on app login/foreground;
    // invalid tokens are pruned on FCM error responses (device-not-registered).
    fcmTokens: {
      type: [String],
      default: [],
    },

    // Terms and Conditions
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
  },
  { timestamps: true }
);

export default mongoose.models.User ||
  mongoose.model("User", userSchema);
