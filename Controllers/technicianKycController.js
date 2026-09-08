import mongoose from "mongoose";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { getTechnicianJobEligibility } from "../Utils/technicianEligibility.js";
import { getSignedKycUrl } from "../Utils/cloudinaryUpload.js";
import { maskAadhaar, maskPan, maskAccount, hashAccountNumber, fingerprintBankDetails } from "../Utils/kycPrivacy.js";
import { writeAuditLog } from "../Utils/audit.js";
import {
  getDekForKycDoc,
  getOrCreateDekForKycDoc,
  encryptIdentityFields,
  encryptBankDetails,
  decryptIdentityFields,
  decryptBankDetails,
} from "../Utils/kycFieldCrypto.js";

const isValidObjectId = mongoose.Types.ObjectId.isValid;

const isOwnerOrAdmin = (req) =>
  req.user?.role === "Owner" || req.user?.role === "Admin";

/* ================= PII SAFETY HELPERS ================= */

// Documents are stored as Cloudinary public_ids (private/authenticated
// resources). Sign them at read time; legacy full URLs pass through.
const signKycDocuments = (docs) => {
  if (!docs) return docs;
  return {
    aadhaarUrl: (docs.aadhaarUrl || []).map(getSignedKycUrl),
    panUrl: (docs.panUrl || []).map(getSignedKycUrl),
    dlUrl: (docs.dlUrl || []).map(getSignedKycUrl),
  };
};

// Decrypt the sensitive fields of a KYC doc into a plaintext copy.
// Transparent for legacy (unencrypted) records.
const toPlaintextKycCopy = async (kycDoc) => {
  if (!kycDoc) return kycDoc;
  const dek = await getDekForKycDoc(kycDoc);
  const plain = {
    ...kycDoc,
    ...decryptIdentityFields(kycDoc, dek),
  };
  if (kycDoc.bankDetails && typeof kycDoc.bankDetails === "object") {
    plain.bankDetails = decryptBankDetails(kycDoc.bankDetails, dek);
  }
  return plain;
};

// Mask identity/bank PII on every non-self read. Decrypts first (fields are
// encrypted at rest) then masks.
const maskKycPii = async (kycDoc) => {
  if (!kycDoc) return kycDoc;
  const plain = await toPlaintextKycCopy(kycDoc);
  const masked = {
    ...plain,
    aadhaarNumber: maskAadhaar(plain.aadhaarNumber),
    panNumber: maskPan(plain.panNumber),
    drivingLicenseNumber: maskPan(plain.drivingLicenseNumber),
  };
  if (plain.bankDetails) {
    masked.bankDetails = {
      ...plain.bankDetails,
      accountNumber: maskAccount(plain.bankDetails.accountNumber),
    };
    delete masked.bankDetails.accountNumberHash;
  }
  return masked;
};

// Persist offline enforcement — mutating only the response copy is cosmetic
// (location pings / matching read the DB value).
const enforceOffline = async (technicianProfileId) => {
  await TechnicianProfile.updateOne(
    { _id: technicianProfileId, "availability.isOnline": true },
    { $set: { "availability.isOnline": false } }
  );
};

/* ================= VALIDATION HELPERS ================= */
const validateBankDetails = (bankDetails) => {
  if (!bankDetails) return { valid: true }; // Optional

  const errors = [];

  if (bankDetails.accountHolderName) {
    if (!/^[a-zA-Z\s]{3,}$/.test(bankDetails.accountHolderName)) {
      errors.push("Account holder name must be 3+ characters, alphabets and spaces only");
    }
  }

  if (bankDetails.bankName) {
    if (!/^[a-zA-Z\s]{3,}$/.test(bankDetails.bankName)) {
      errors.push("Bank name must be 3+ characters, alphabets and spaces only");
    }
  }

  if (bankDetails.accountNumber) {
    if (!/^\d{9,18}$/.test(bankDetails.accountNumber)) {
      errors.push("Account number must be 9-18 digits only");
    }
  }

  if (bankDetails.ifscCode) {
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankDetails.ifscCode.toUpperCase())) {
      errors.push("Invalid IFSC code format. Must be: 4 uppercase letters + 0 + 6 alphanumeric characters");
    }
  }

  if (bankDetails.branchName) {
    if (bankDetails.branchName.length < 3) {
      errors.push("Branch name must be at least 3 characters");
    }
  }

  if (bankDetails.upiId) {
    if (!/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(bankDetails.upiId)) {
      errors.push("Invalid UPI ID format. Example: username@bank");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

const titleCase = (str) => {
  if (!str) return str;
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

/* ================= SUBMIT / UPDATE TECHNICIAN KYC DETAILS ================= */
export const submitTechnicianKyc = async (req, res) => {
  try {
    const {
      aadhaarNumber,
      panNumber,
      drivingLicenseNumber,
    } = req.body;
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    // Load (or create) the doc so we can unwrap/attach the per-document DEK
    // and encrypt the identity numbers before persisting.
    let kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId });
    if (!kyc) {
      kyc = new TechnicianKyc({ technicianId: technicianProfileId });
    }
    const dek = await getOrCreateDekForKycDoc(kyc);

    kyc.set({
      ...encryptIdentityFields(aadhaarNumber, panNumber, drivingLicenseNumber, dek),
      verificationStatus: "pending",
      rejectionReason: null,
      kycVerified: false,
    });

    await kyc.save();

    const kycObj = kyc.toObject();

    // Self data — return plaintext, not ciphertext.
    Object.assign(kycObj, decryptIdentityFields(kyc, dek));

    return res.status(200).json({
      success: true,
      message: "KYC details saved successfully",
      result: kycObj,
    });
  } catch (error) {
    console.error("submitTechnicianKyc error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= SUBMIT / UPDATE TECHNICIAN BANK DETAILS (PLAINTEXT) ================= */
export const submitTechnicianBankDetails = async (req, res) => {
  try {
    const bankDetails = req.body;
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    // Validate bank details
    const bankValidation = validateBankDetails(bankDetails);
    if (!bankValidation.valid) {
      return res.status(400).json({
        success: false,
        message: "Invalid bank details",
        result: { errors: bankValidation.errors },
      });
    }

    // 🔍 Check for duplicate account number — unified hash-based check.
    // Mirrors the hash used by the User profile write path (Utils/kycPrivacy.js),
    // plus a plaintext fallback for legacy records created before hashing existed.
    if (bankDetails.accountNumber) {
      const trimmedAccountNumber = String(bankDetails.accountNumber).trim();
      const accountNumberHash = hashAccountNumber(trimmedAccountNumber);

      const duplicateAccount = await TechnicianKyc.findOne({
        $or: [
          { "bankDetails.accountNumberHash": accountNumberHash },
          { "bankDetails.accountNumber": trimmedAccountNumber },
        ],
        technicianId: { $ne: technicianProfileId },
      });

      if (duplicateAccount) {
        return res.status(400).json({
          success: false,
          message: "Account number already registered with another technician",
          result: { field: "accountNumber" },
        });
      }
    }

    const processedBankDetails = {
      accountHolderName: bankDetails.accountHolderName
        ? titleCase(bankDetails.accountHolderName.trim())
        : bankDetails.accountHolderName,
      bankName: bankDetails.bankName ? bankDetails.bankName.trim() : bankDetails.bankName,
      accountNumber: bankDetails.accountNumber ? String(bankDetails.accountNumber).trim() : bankDetails.accountNumber,
      accountNumberHash: bankDetails.accountNumber ? hashAccountNumber(bankDetails.accountNumber) : null,
      ifscCode: bankDetails.ifscCode ? bankDetails.ifscCode.toUpperCase().trim() : bankDetails.ifscCode,
      branchName: bankDetails.branchName ? bankDetails.branchName.trim() : bankDetails.branchName,
      upiId: bankDetails.upiId ? bankDetails.upiId.toLowerCase().trim() : bankDetails.upiId,
    };

    // Load (or create) the doc for the per-document DEK and encrypt the
    // sensitive bank fields before persisting.
    let kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId });
    if (!kyc) {
      kyc = new TechnicianKyc({ technicianId: technicianProfileId });
    }
    const dek = await getOrCreateDekForKycDoc(kyc);

    const updateData = {
      bankDetails: encryptBankDetails(processedBankDetails, dek),
      bankVerificationStatus: "pending",
      bankRejectionReason: null,
      bankVerified: false,
      bankUpdateRequired: false,
      bankEditableUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days grace period
    };

    kyc.set(updateData);
    await kyc.save();

    // 🔒 Razorpay X fund_account is bound to the bank/UPI details. The cached
    // id becomes invalid when the account changes — clear it so the next
    // payout creates a fresh fund account for the NEW bank details.
    await TechnicianProfile.updateOne(
      { _id: technicianProfileId },
      { $unset: { razorpayFundAccountId: 1 } }
    );

    const kycObj = kyc.toObject();
    // Self data — return plaintext, not ciphertext.
    if (kycObj.bankDetails) {
      kycObj.bankDetails = decryptBankDetails(kycObj.bankDetails, dek);
      delete kycObj.bankDetails.accountNumberHash;
    }

    return res.status(200).json({
      success: true,
      message: "Bank details saved successfully",
      result: kycObj,
    });
  } catch (error) {
    console.error("submitTechnicianBankDetails error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPLOAD TECHNICIAN KYC DOCUMENTS (IMAGES) ================= */
export const uploadTechnicianKycDocuments = async (req, res) => {
  try {
    const authUserId = req.user?.userId;

    if (!authUserId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({
        success: false,
        message: "KYC documents are required",
        result: {},
      });
    }

    // Enforce Technician role for KYC documents upload
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Technician access only",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    // Store Cloudinary public_ids (files live in private/authenticated
    // storage); signed URLs are generated at read time.
    if (req.files.aadhaarImage) {
      kyc.documents.aadhaarUrl = req.files.aadhaarImage.map((f) => f.filename || f.path);
    }

    if (req.files.panImage) {
      kyc.documents.panUrl = req.files.panImage.map((f) => f.filename || f.path);
    }

    if (req.files.dlImage) {
      kyc.documents.dlUrl = req.files.dlImage.map((f) => f.filename || f.path);
    }

    // Any document change invalidates the previous approval — force re-review.
    // No exceptions, including already-approved records.
    kyc.verificationStatus = "pending";
    kyc.kycVerified = false;
    kyc.verifiedBy = undefined;
    kyc.verifiedAt = null;
    kyc.rejectionReason = null;

    await kyc.save();

    const fullKyc = await TechnicianKyc.findById(kyc._id);
    const dek = await getDekForKycDoc(fullKyc);
    const kycObj = fullKyc.toObject();
    // Self data — return plaintext, not ciphertext.
    Object.assign(kycObj, decryptIdentityFields(fullKyc, dek));
    if (kycObj.bankDetails) {
      kycObj.bankDetails = decryptBankDetails(kycObj.bankDetails, dek);
      delete kycObj.bankDetails.accountNumberHash;
    }
    kycObj.documents = signKycDocuments(kycObj.documents);

    return res.status(200).json({
      success: true,
      message: "KYC images uploaded successfully. Verification status reset to pending.",
      result: kycObj,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET ALL TECHNICIAN KYC (ADMIN ONLY) ================= */
export const getAllTechnicianKyc = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    const kycDocs = await TechnicianKyc.find().lean();

    const technicianIds = Array.from(
      new Set(
        kycDocs
          .map((k) => k.technicianId)
          .filter((id) => id && isValidObjectId(id))
          .map((id) => id.toString())
      )
    ).map((id) => new mongoose.Types.ObjectId(id));

    const technicians = technicianIds.length
      ? await TechnicianProfile.find({ _id: { $in: technicianIds } })
        .select("-__v -bankDetails")
        .populate({
          path: "userId",
          select: "-password -__v",
          options: { lean: true },
        })
        .lean()
      : [];

    const techById = new Map(technicians.map((t) => [t._id.toString(), t]));

    // Persist offline enforcement (single batched write)
    const ineligibleTechnicianIds = [];

    const kyc = [];
    for (const k of kycDocs) {
      const technicianIdRaw = k.technicianId ? k.technicianId.toString() : null;
      const technician = technicianIdRaw ? techById.get(technicianIdRaw) : null;
      const user = technician?.userId || null;
      const technicianResult = technician
        ? {
          ...technician,
          _id: technician._id,
          userId: user?._id || null,
          fname: user?.fname || null,
          lname: user?.lname || null,
          gender: user?.gender || null,
          mobileNumber: user?.mobileNumber || null,
          email: user?.email || null,
        }
        : null;

      // ================= ENFORCE ONLINE PREREQUISITES INTEGRITY =================
      if (technicianResult) {
        const canBeOnline =
          technicianResult.trainingCompleted === true &&
          technicianResult.workStatus === "approved" &&
          k.verificationStatus === "approved";

        if (!canBeOnline) {
          technicianResult.availability = technicianResult.availability || {};
          technicianResult.availability.isOnline = false;
          ineligibleTechnicianIds.push(technicianResult._id.toString());
        }
      }

      kyc.push({
        ...(await maskKycPii(k)),
        documents: signKycDocuments(k.documents),
        technicianId: technicianResult,
        technicianIdRaw,
        technicianIdMissing: technicianIdRaw === null,
        orphanedTechnician: technicianIdRaw !== null && !technician,
      });
    }

    const filteredKyc = kyc.filter((k) => !k.orphanedTechnician && k.technicianId !== null);

    if (ineligibleTechnicianIds.length > 0) {
      await TechnicianProfile.updateMany(
        {
          _id: { $in: ineligibleTechnicianIds },
          "availability.isOnline": true,
        },
        { $set: { "availability.isOnline": false } }
      );
    }

    return res.status(200).json({
      success: true,
      message: "KYC fetched successfully",
      result: filteredKyc,
      meta: {
        total: filteredKyc.length
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET TECHNICIAN KYC (ADMIN / SELF) ================= */
export const getTechnicianKyc = async (req, res) => {
  try {
    const { technicianId } = req.params;

    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    const isPrivileged = isOwnerOrAdmin(req);
    if (!isPrivileged) {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId || technicianProfileId.toString() !== technicianId) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
          result: {},
        });
      }
    }

    const kycDoc = await TechnicianKyc.findOne({ technicianId }).lean();

    if (!kycDoc) {
      return res.status(200).json({
        success: true,
        message: "KYC record not found",
        result: null,
      });
    }

    const technician = await TechnicianProfile.findById(technicianId)
      .select("-__v -bankDetails")
      .populate({
        path: "userId",
        select: "-password -__v",
        options: { lean: true }
      })
      .lean();

    // ================= ENFORCE ONLINE PREREQUISITES INTEGRITY =================
    if (technician) {
      const canBeOnline =
        technician.trainingCompleted === true &&
        technician.workStatus === "approved" &&
        kycDoc.verificationStatus === "approved";

      if (!canBeOnline) {
        // Persist the enforcement — not just the response copy
        await enforceOffline(technicianId);
        technician.availability = technician.availability || {};
        technician.availability.isOnline = false;
      }
    }

    const result = {
      ...(await maskKycPii(kycDoc)),
      documents: signKycDocuments(kycDoc.documents),
      technicianId: technician ? {
        ...technician,
        _id: technician._id,
        fname: technician?.userId?.fname || null,
        lname: technician?.userId?.lname || null,
        mobileNumber: technician?.userId?.mobileNumber || null,
        email: technician?.userId?.email || null,
        userId: technician?.userId?._id || null
      } : null,
      technicianIdRaw: technicianId,
      orphanedTechnician: !technician,
    };

    return res.status(200).json({
      success: true,
      message: "KYC fetched successfully",
      result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET MY TECHNICIAN KYC (TOKEN AUTH) ================= */
export const getMyTechnicianKyc = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;

    if (!technicianProfileId || !isValidObjectId(technicianProfileId)) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId })
      .populate({
        path: "technicianId",
        select: "-__v -bankDetails",
        populate: {
          path: "userId",
          select: "-password -__v"
        }
      });

    const eligibility = await getTechnicianJobEligibility({ technicianProfileId });

    if (!kyc) {
      return res.status(200).json({
        success: true,
        message: "KYC record not initialized",
        result: {
          technicianId: technicianProfileId,
          kycVerified: false,
          verificationStatus: "pending",
          bankVerified: false,
          bankVerificationStatus: "pending",
          bankDetails: null,
          documents: { aadhaarUrl: [], panUrl: [], dlUrl: [] },
          eligibility: {
            ...eligibility,
            canWork: false,
          },
        },
      });
    }

    const dek = await getDekForKycDoc(kyc);
    const kycObj = kyc.toObject();

    // Self data — return plaintext, not ciphertext.
    Object.assign(kycObj, decryptIdentityFields(kyc, dek));

    // ================= ENFORCE ONLINE PREREQUISITES INTEGRITY =================
    if (kycObj.technicianId) {
      const tech = kycObj.technicianId;
      const canBeOnline =
        tech.trainingCompleted === true &&
        tech.workStatus === "approved" &&
        kycObj.verificationStatus === "approved";

      if (!canBeOnline) {
        // Persist the enforcement — not just the response copy
        await enforceOffline(technicianProfileId);
        tech.availability = tech.availability || {};
        tech.availability.isOnline = false;
      }
    }

    const workStatus = kycObj?.technicianId?.workStatus || null;
    const bankApproved = kycObj.bankVerificationStatus === "approved" || kycObj.bankVerified === true;

    const normalizedBankVerificationStatus = bankApproved ? "approved" : (kycObj.bankVerificationStatus || "pending");
    const normalizedBankVerified = bankApproved;

    const normalizedEligibility = {
      ...eligibility,
      canWork: workStatus === "approved" ? eligibility.eligible : false,
      status: {
        ...eligibility.status,
        workStatus,
      },
    };

    if (kycObj.bankDetails) {
      kycObj.bankDetails = decryptBankDetails(kycObj.bankDetails, dek);
      delete kycObj.bankDetails.accountNumberHash;
    }
    kycObj.documents = signKycDocuments(kycObj.documents);

    return res.status(200).json({
      success: true,
      message: "KYC fetched successfully",
      result: {
        ...kycObj,
        bankVerified: normalizedBankVerified,
        bankVerificationStatus: normalizedBankVerificationStatus,
        eligibility: normalizedEligibility,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET FULL KYC PII (AUDITED, OWNER/ADMIN ONLY) ================= */
// Unlike the regular reads (which mask PII), this returns the full identity
// and bank details. Every access is written to the audit log. Use only for
// fraud cases / document verification where the masked view is insufficient.
export const getTechnicianKycFull = async (req, res) => {
  try {
    const { technicianId } = req.params;

    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Technician ID",
        result: {},
      });
    }

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    const kycDoc = await TechnicianKyc.findOne({ technicianId }).lean();

    if (!kycDoc) {
      return res.status(200).json({
        success: true,
        message: "KYC record not found",
        result: null,
      });
    }

    // 🔏 Audit the access — who saw full PII, when, for whom
    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "KYC_FULL_PII_VIEW",
      targetType: "TechnicianKyc",
      targetId: kycDoc._id,
      metadata: { technicianId },
    });

    const dek = await getDekForKycDoc(kycDoc);
    Object.assign(kycDoc, decryptIdentityFields(kycDoc, dek));
    if (kycDoc.bankDetails) {
      kycDoc.bankDetails = decryptBankDetails(kycDoc.bankDetails, dek);
      delete kycDoc.bankDetails.accountNumberHash;
    }
    kycDoc.documents = signKycDocuments(kycDoc.documents);

    return res.status(200).json({
      success: true,
      message: "Full KYC details fetched (audited)",
      result: kycDoc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= ADMIN VERIFY / REJECT TECHNICIAN KYC ================= */
export const verifyTechnicianKyc = async (req, res) => {
  try {
    const { technicianId, status, rejectionReason } = req.body;

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    if (!technicianId || !isValidObjectId(technicianId) || !status) {
      return res.status(400).json({
        success: false,
        message: "Technician ID and status are required",
        result: {},
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid verification status",
        result: {},
      });
    }

    if (status === "rejected" && !rejectionReason) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId }).select("+bankDetails.accountNumber");
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    // Decrypt the sensitive fields in memory for verification decisions and
    // the fingerprint. Persisted data stays encrypted.
    const dek = await getDekForKycDoc(kyc);
    const plainIdentity = decryptIdentityFields(kyc, dek);
    const plainBank = decryptBankDetails(kyc.bankDetails, dek);

    // CHECK BEFORE APPROVAL - Validate all required identity documents
    if (status === "approved") {
      const missingFields = [];

      // Check KYC Documents
      if (!plainIdentity.aadhaarNumber) missingFields.push("Aadhaar Number");
      if (!kyc.documents?.aadhaarUrl || kyc.documents.aadhaarUrl.length === 0) missingFields.push("Aadhaar Images");

      if (!plainIdentity.panNumber) missingFields.push("PAN Number");
      if (!kyc.documents?.panUrl || kyc.documents.panUrl.length === 0) missingFields.push("PAN Image");

      if (!plainIdentity.drivingLicenseNumber) missingFields.push("Driving License Number");
      if (!kyc.documents?.dlUrl || kyc.documents.dlUrl.length === 0) missingFields.push("Driving License Images");

      // If any required identity field is missing, reject the approval
      if (missingFields.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot approve KYC. Missing required identity documents",
          result: {
            missingFields: missingFields,
            details: "Please ensure all documents (Aadhaar, PAN, Driving License with images) are complete before approval."
          },
        });
      }
    }

    const previousStatus = kyc.verificationStatus;
    kyc.verificationStatus = status;
    kyc.kycVerified = status === "approved";
    kyc.rejectionReason = status === "rejected" ? rejectionReason : null;
    kyc.verifiedAt = new Date();
    kyc.verifiedBy = req.user.userId;

    if (status === "approved") {
      // Training is a prerequisite for KYC approval
      const technicianProfile = await TechnicianProfile.findById(technicianId).select("trainingCompleted");
      if (!technicianProfile || !technicianProfile.trainingCompleted) {
        return res.status(400).json({
          success: false,
          message: "Technician must complete training before KYC approval",
          result: { trainingCompleted: false },
        });
      }
    }

    await kyc.save();

    // 🔏 Audit the approval/rejection decision
    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: status === "approved" ? "KYC_APPROVED" : "KYC_REJECTED",
      targetType: "TechnicianKyc",
      targetId: kyc._id,
      before: { verificationStatus: previousStatus },
      after: { verificationStatus: status },
      reason: status === "rejected" ? rejectionReason : null,
      metadata: { technicianId },
    });

    if (status === "approved") {
      await TechnicianProfile.findByIdAndUpdate(technicianId, {
        workStatus: "approved",
        approvedAt: new Date(),
      });
    } else {
      await TechnicianProfile.findByIdAndUpdate(technicianId, {
        workStatus: "suspended",
        "availability.isOnline": false,
      });
    }

    const kycObj = await maskKycPii(kyc.toObject());
    kycObj.documents = signKycDocuments(kycObj.documents);

    return res.status(200).json({
      success: true,
      message: `KYC ${status} successfully`,
      result: kycObj,
    });
  } catch (error) {
    console.error("verifyTechnicianKyc error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= ADMIN VERIFY / REJECT BANK DETAILS ================= */
export const verifyBankDetails = async (req, res) => {
  try {
    const { technicianId, verified, bankRejectionReason } = req.body;

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    if (!technicianId || !isValidObjectId(technicianId) || typeof verified !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "Technician ID and 'verified' boolean are required",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId });
    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    const dek = await getDekForKycDoc(kyc);
    const plainBank = decryptBankDetails(kyc.bankDetails, dek);

    if (!plainBank?.accountNumber || !plainBank?.upiId) {
      return res.status(400).json({
        success: false,
        message: "Incomplete details: Both Bank Account details and UPI ID are required for verification",
        result: {
          hasAccountNumber: Boolean(plainBank?.accountNumber),
          hasUpiId: Boolean(plainBank?.upiId),
        },
      });
    }

    const technician = await TechnicianProfile.findById(technicianId).select("trainingCompleted");
    if (!technician || !technician.trainingCompleted) {
      return res.status(403).json({
        success: false,
        message: "Technician must complete training before bank verification",
        result: { trainingCompleted: false },
      });
    }

    const previousBankStatus = kyc.bankVerificationStatus;
    kyc.bankVerified = verified;
    kyc.bankVerificationStatus = verified ? "approved" : "rejected";
    kyc.bankRejectionReason = verified ? null : bankRejectionReason;
    kyc.bankVerifiedAt = new Date();
    kyc.bankVerifiedBy = req.user.userId;
    kyc.bankUpdateRequired = !verified;
    kyc.bankEditableUntil = verified ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // Capture the exact details that were verified
    kyc.bankDetailsFingerprint = verified ? fingerprintBankDetails(plainBank) : null;

    await kyc.save();

    // 🔏 Audit the bank verification decision
    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: verified ? "BANK_VERIFIED" : "BANK_REJECTED",
      targetType: "TechnicianKyc",
      targetId: kyc._id,
      before: { bankVerificationStatus: previousBankStatus },
      after: { bankVerificationStatus: verified ? "approved" : "rejected" },
      reason: verified ? null : bankRejectionReason,
      metadata: { technicianId },
    });

    const kycObj = await maskKycPii(kyc.toObject());
    kycObj.documents = signKycDocuments(kycObj.documents);

    return res.status(200).json({
      success: true,
      message: `Bank details ${verified ? "verified" : "rejected"} successfully`,
      result: kycObj,
    });
  } catch (error) {
    console.error("verifyBankDetails error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE TECHNICIAN KYC ================= */
export const deleteTechnicianKyc = async (req, res) => {
  try {
    const { technicianId } = req.params;

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    const result = await TechnicianKyc.findOneAndDelete({ technicianId });

    if (!result) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "KYC record deleted successfully",
      result: { technicianId },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET ORPHANED KYC (NO MATCHING TECHNICIAN) ================= */
export const getOrphanedKyc = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    const kycDocs = await TechnicianKyc.find().lean();

    // Manual check for orphans since we want to list exactly what is broken
    const orphans = [];
    for (const k of kycDocs) {
      if (!k.technicianId || !isValidObjectId(k.technicianId)) {
        orphans.push({ ...k, reason: "id_missing_or_invalid" });
        continue;
      }
      const tech = await TechnicianProfile.findById(k.technicianId).select("_id");
      if (!tech) {
        orphans.push({ ...k, reason: "technician_not_found" });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Orphaned KYC fetched successfully",
      result: orphans,
      meta: { count: orphans.length }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE SPECIFIC ORPHANED KYC ================= */
export const deleteOrphanedKyc = async (req, res) => {
  try {
    const { kycId } = req.params;

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    const result = await TechnicianKyc.findByIdAndDelete(kycId);
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Orphaned KYC deleted successfully",
      result: { kycId },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE ALL ORPHANED KYC ================= */
export const deleteAllOrphanedKyc = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Owner/Admin access only",
        result: {},
      });
    }

    const kycDocs = await TechnicianKyc.find().lean();
    let deletedCount = 0;

    for (const k of kycDocs) {
      let isOrphan = false;
      if (!k.technicianId || !isValidObjectId(k.technicianId)) {
        isOrphan = true;
      } else {
        const tech = await TechnicianProfile.findById(k.technicianId).select("_id");
        if (!tech) isOrphan = true;
      }

      if (isOrphan) {
        await TechnicianKyc.findByIdAndDelete(k._id);
        deletedCount++;
      }
    }

    return res.status(200).json({
      success: true,
      message: "All orphaned KYC records cleaned up",
      result: { deletedCount },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= ADMIN UPDATE TECHNICIAN KYC DETAILS ================= */
// Admin/Owner can correct a technician's identity KYC fields (Aadhaar/PAN/DL).
// Any change resets the KYC verification to pending so it is re-approved.
export const adminUpdateTechnicianKycDetails = async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { aadhaarNumber, panNumber, drivingLicenseNumber } = req.body;

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only", result: {} });
    }
    if (!technicianId || !isValidObjectId(technicianId)) {
      return res.status(400).json({ success: false, message: "Valid technicianId is required", result: {} });
    }
    if (
      aadhaarNumber === undefined &&
      panNumber === undefined &&
      drivingLicenseNumber === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one of aadhaarNumber, panNumber, drivingLicenseNumber",
        result: {},
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId });
    if (!kyc) {
      return res.status(404).json({ success: false, message: "KYC record not found", result: {} });
    }

    const dek = await getOrCreateDekForKycDoc(kyc);
    const existing = decryptIdentityFields(kyc, dek);
    const merged = {
      aadhaarNumber: aadhaarNumber !== undefined ? aadhaarNumber : existing.aadhaarNumber,
      panNumber: panNumber !== undefined ? panNumber : existing.panNumber,
      drivingLicenseNumber:
        drivingLicenseNumber !== undefined ? drivingLicenseNumber : existing.drivingLicenseNumber,
    };

    kyc.set(encryptIdentityFields(merged.aadhaarNumber, merged.panNumber, merged.drivingLicenseNumber, dek));
    // Identity changed → reset verification (must be re-approved by admin).
    kyc.verificationStatus = "pending";
    kyc.kycVerified = false;
    kyc.rejectionReason = null;
    await kyc.save();

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "KYC_DETAILS_UPDATED_BY_ADMIN",
      targetType: "TechnicianKyc",
      targetId: kyc._id,
      after: { technicianId, fields: Object.keys(req.body) },
      metadata: { technicianId },
    });

    const kycObj = await maskKycPii(kyc.toObject());
    kycObj.documents = signKycDocuments(kycObj.documents);

    return res.status(200).json({
      success: true,
      message: "KYC details updated successfully",
      result: kycObj,
    });
  } catch (error) {
    console.error("adminUpdateTechnicianKycDetails error:", error);
    return res.status(500).json({ success: false, message: error.message || "Server error", result: {} });
  }
};

/* ================= ADMIN UPDATE TECHNICIAN BANK DETAILS ================= */
// Admin/Owner can correct a technician's bank/UPI details. Re-encrypts,
// recomputes the verification fingerprint, resets bank verification to pending,
// and clears the cached RazorpayX fund account (bound to old details).
export const adminUpdateTechnicianBankDetails = async (req, res) => {
  try {
    const { technicianId } = req.params;
    const bankDetails = req.body || {};

    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only", result: {} });
    }
    if (!technicianId || !isValidObjectId(technicianId)) {
      return res.status(400).json({ success: false, message: "Valid technicianId is required", result: {} });
    }

    const validation = validateBankDetails(bankDetails);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: "Invalid bank details",
        result: { errors: validation.errors },
      });
    }

    const kyc = await TechnicianKyc.findOne({ technicianId });
    if (!kyc) {
      return res.status(404).json({ success: false, message: "KYC record not found", result: {} });
    }

    const dek = await getDekForKycDoc(kyc);
    const existingBank = decryptBankDetails(kyc.bankDetails, dek) || {};

    // Merge provided fields over the existing ones (partial updates allowed).
    const merged = {
      accountHolderName: bankDetails.accountHolderName ?? existingBank.accountHolderName,
      bankName: bankDetails.bankName ?? existingBank.bankName,
      accountNumber: bankDetails.accountNumber ?? existingBank.accountNumber,
      ifscCode: bankDetails.ifscCode ?? existingBank.ifscCode,
      branchName: bankDetails.branchName ?? existingBank.branchName,
      upiId: bankDetails.upiId ?? existingBank.upiId,
    };

    const trimmedAccountNumber = merged.accountNumber ? String(merged.accountNumber).trim() : null;
    const accountNumberHash = trimmedAccountNumber ? hashAccountNumber(trimmedAccountNumber) : null;

    // Duplicate account guard (exclude the technician being updated).
    if (trimmedAccountNumber) {
      const duplicate = await TechnicianKyc.findOne({
        $or: [
          { "bankDetails.accountNumberHash": accountNumberHash },
          { "bankDetails.accountNumber": trimmedAccountNumber },
        ],
        technicianId: { $ne: technicianId },
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: "Account number already registered with another technician",
          result: { field: "accountNumber" },
        });
      }
    }

    const processedBankDetails = {
      accountHolderName: merged.accountHolderName
        ? titleCase(String(merged.accountHolderName).trim())
        : merged.accountHolderName,
      bankName: merged.bankName ? String(merged.bankName).trim() : merged.bankName,
      accountNumber: trimmedAccountNumber,
      accountNumberHash,
      ifscCode: merged.ifscCode ? String(merged.ifscCode).toUpperCase().trim() : merged.ifscCode,
      branchName: merged.branchName ? String(merged.branchName).trim() : merged.branchName,
      upiId: merged.upiId ? String(merged.upiId).toLowerCase().trim() : merged.upiId,
    };

    kyc.set({
      bankDetails: encryptBankDetails(processedBankDetails, dek),
      bankVerificationStatus: "pending",
      bankRejectionReason: null,
      bankVerified: false,
      bankUpdateRequired: false,
      bankEditableUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      bankDetailsFingerprint: null,
    });
    await kyc.save();

    // Cached RazorpayX fund account is bound to the old bank/UPI — invalidate it.
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      { $unset: { razorpayFundAccountId: 1 } }
    );

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "BANK_DETAILS_UPDATED_BY_ADMIN",
      targetType: "TechnicianKyc",
      targetId: kyc._id,
      after: { technicianId, fields: Object.keys(req.body) },
      metadata: { technicianId },
    });

    const kycObj = await maskKycPii(kyc.toObject());
    kycObj.documents = signKycDocuments(kycObj.documents);

    return res.status(200).json({
      success: true,
      message: "Bank details updated successfully",
      result: kycObj,
    });
  } catch (error) {
    console.error("adminUpdateTechnicianBankDetails error:", error);
    return res.status(500).json({ success: false, message: error.message || "Server error", result: {} });
  }
};
