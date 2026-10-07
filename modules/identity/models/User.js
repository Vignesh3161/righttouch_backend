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

    // P7 compatibility mirror (DEPRECATED — do not read for decisions).
    // Canonical source: computeProfileComplete() (identity/utils).
    // All writers route through it; /me derives the response from it.
    // Retained only so pre-P7 documents and external response shapes keep
    // working. Removal condition (Stage G): every consumer proven to use
    // the canonical computation + backfill verified. Never delete blindly.
    profileComplete: {
      type: Boolean,
      default: false,
    },

    // P5 — global session invalidation counter. Every newly issued access
    // token carries this value; logout-all (and other security events)
    // increment it, which instantly invalidates all previously issued
    // access tokens via the central resolveAuth policy. Default 0 keeps
    // every pre-P5 user valid without a migration (their legacy tokens
    // carry no version claim and stay on the compat path).
    tokenVersion: {
      type: Number,
      default: 0,
    },

    lastLoginAt: Date,

    // 📱 P7 compatibility mirror (DEPRECATED — DeviceToken is canonical).
    // Dual-written by deviceRepository/permissionService so legacy push
    // keeps working during transition; canonical reads use the
    // DeviceToken collection. Removal condition (Stage G): backfill
    // verified + all readers proven DeviceToken-only. Never delete blindly.
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
