import mongoose from "mongoose";

const technicianKycSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      unique: true,
      index: true,
    },

    /* ==========================
       📋 KYC DOCUMENTS (ENCRYPTED AT REST)
       Sensitive identity fields are AES-256-GCM encrypted at rest
       (envelope encryption via Utils/kycFieldCrypto.js). They hold either
       legacy plaintext strings (pre-encryption records) or ciphertext
       objects { ciphertext, iv, authTag }. All code MUST go through
       decryptIdentityFields/decryptBankDetails to read them.
    ========================== */
    aadhaarNumber: {
      type: mongoose.Schema.Types.Mixed,
      sparse: true,
      index: true,
    },

    panNumber: {
      type: mongoose.Schema.Types.Mixed,
      sparse: true,
      index: true,
    },

    drivingLicenseNumber: {
      type: mongoose.Schema.Types.Mixed,
      sparse: true,
      index: true,
    },

    documents: {
      aadhaarUrl: [String],
      panUrl: [String],
      dlUrl: [String],
    },

    kycVerified: {
      type: Boolean,
      default: false,
    },

    verificationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    rejectionReason: {
      type: String,
      trim: true,
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // admin
    },

    verifiedAt: {
      type: Date,
    },

    /* ==========================
       💳 BANK & SALARY PAYOUT DETAILS
       accountHolderName / accountNumber / ifscCode / upiId are encrypted
       at rest (same scheme as identity fields). bankName and branchName
       are NOT sensitive — kept as plaintext strings.
    ========================== */
    bankDetails: {
      accountHolderName: {
        type: mongoose.Schema.Types.Mixed,
      },

      bankName: {
        type: String,
        trim: true,
      },

      accountNumber: {
        type: mongoose.Schema.Types.Mixed,
        sparse: true,
      },

      // SHA-256 of accountNumber — deterministic, used for dedup lookups
      // ONLY. Never decryptable, never returned in responses.
      accountNumberHash: {
        type: String,
        trim: true,
        sparse: true,
        index: true,
      },

      ifscCode: {
        type: mongoose.Schema.Types.Mixed,
      },

      branchName: {
        type: String,
        trim: true,
      },

      upiId: {
        type: mongoose.Schema.Types.Mixed,
      },
    },

    bankVerified: {
      type: Boolean,
      default: false,
    },

    // Fingerprint (SHA-256) of the exact bank details that were verified.
    // Recomputed before every payout — if the current details no longer
    // match, verification is invalid and the payout is blocked.
    bankDetailsFingerprint: {
      type: String,
      trim: true,
      default: null,
    },

    bankUpdateRequired: {
      type: Boolean,
      default: false,
    },

    bankVerificationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    bankRejectionReason: {
      type: String,
      trim: true,
    },

    bankVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // admin
    },

    bankVerifiedAt: {
      type: Date,
    },

    bankEditableUntil: {
      type: Date, // After verification, this is set to null
    },

    /* ==========================
       🔐 ENVELOPE ENCRYPTION
       Per-document Data Encryption Key, itself encrypted by the KMS master
       key (Utils/kmsClient.js). Presence of this field marks the document
       as encrypted; records without it are legacy plaintext and are read
       transparently.
    ========================== */
    encryptedDek: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.models.TechnicianKyc || mongoose.model("TechnicianKyc", technicianKycSchema);
