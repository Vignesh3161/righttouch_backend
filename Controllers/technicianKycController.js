import mongoose from "mongoose";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { getTechnicianJobEligibility } from "../Utils/technicianEligibility.js";

const isValidObjectId = mongoose.Types.ObjectId.isValid;

const isOwnerOrAdmin = (req) =>
  req.user?.role === "Owner" || req.user?.role === "Admin";

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

/* ================= SUBMIT / UPDATE TECHNICIAN KYC DETAILS (PLAINTEXT) ================= */
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

    // Prepare update object
    const updateData = {
      technicianId: technicianProfileId,
      aadhaarNumber,
      panNumber,
      drivingLicenseNumber,
      verificationStatus: "pending",
      rejectionReason: null,
      kycVerified: false,
    };

    const kyc = await TechnicianKyc.findOneAndUpdate(
      { technicianId: technicianProfileId },
      updateData,
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    );

    const kycObj = kyc.toObject();

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

    // 🔍 Check for duplicate account number (Plaintext check)
    if (bankDetails.accountNumber) {
      const trimmedAccountNumber = String(bankDetails.accountNumber).trim();

      const duplicateAccount = await TechnicianKyc.findOne({
        "bankDetails.accountNumber": trimmedAccountNumber,
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
      ifscCode: bankDetails.ifscCode ? bankDetails.ifscCode.toUpperCase().trim() : bankDetails.ifscCode,
      branchName: bankDetails.branchName ? bankDetails.branchName.trim() : bankDetails.branchName,
      upiId: bankDetails.upiId ? bankDetails.upiId.toLowerCase().trim() : bankDetails.upiId,
    };

    const updateData = {
      bankDetails: processedBankDetails,
      bankVerificationStatus: "pending",
      bankRejectionReason: null,
      bankVerified: false,
      bankUpdateRequired: false,
      bankEditableUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days grace period
    };

    const kyc = await TechnicianKyc.findOneAndUpdate(
      { technicianId: technicianProfileId },
      updateData,
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    );

    const kycObj = kyc.toObject();

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

    if (req.files.aadhaarImage) {
      kyc.documents.aadhaarUrl = req.files.aadhaarImage.map((f) => f.path);
    }

    if (req.files.panImage) {
      kyc.documents.panUrl = req.files.panImage.map((f) => f.path);
    }

    if (req.files.dlImage) {
      kyc.documents.dlUrl = req.files.dlImage.map((f) => f.path);
    }

    await kyc.save();

    const fullKyc = await TechnicianKyc.findById(kyc._id);
    const kycObj = fullKyc.toObject();

    return res.status(200).json({
      success: true,
      message: "KYC images uploaded successfully",
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
        .select("-__v")
        .populate({
          path: "userId",
          select: "-password -__v",
          options: { lean: true },
        })
        .lean()
      : [];

    const techById = new Map(technicians.map((t) => [t._id.toString(), t]));

    const kyc = kycDocs
      .map((k) => {
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
            technicianResult.workStatus === "approved";

          if (canBeOnline && k.verificationStatus !== "approved") {
            technicianResult.availability = technicianResult.availability || {};
            technicianResult.availability.isOnline = false;
          } else if (!canBeOnline) {
            technicianResult.availability = technicianResult.availability || {};
            technicianResult.availability.isOnline = false;
          }
        }

        if (k.bankDetails) {
          delete k.bankDetails.accountNumberHash;
        }

        return {
          ...k,
          technicianId: technicianResult,
          technicianIdRaw,
          technicianIdMissing: technicianIdRaw === null,
          orphanedTechnician: technicianIdRaw !== null && !technician,
        };
      })
      .filter(k => !k.orphanedTechnician && k.technicianId !== null);

    return res.status(200).json({
      success: true,
      message: "KYC fetched successfully",
      result: kyc,
      meta: {
        total: kyc.length
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

    const kycDoc = await TechnicianKyc.findOne({ technicianId }).lean();

    if (!kycDoc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
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

    const technician = await TechnicianProfile.findById(technicianId)
      .select("-__v")
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
        technician.workStatus === "approved";

      if (canBeOnline) {
        // Also verify KYC is approved
        if (kycDoc.verificationStatus !== "approved") {
          technician.availability = technician.availability || {};
          technician.availability.isOnline = false;
          console.warn(
            `⚠️ Enforced offline for technician ${technicianId}: KYC status is ${kycDoc.verificationStatus}`
          );
        }
      } else {
        // Force offline if any prerequisite not met
        technician.availability = technician.availability || {};
        technician.availability.isOnline = false;
      }
    }

    if (kycDoc.bankDetails) {
      delete kycDoc.bankDetails.accountNumberHash;
    }

    const result = {
      ...kycDoc,
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
        select: "-__v",
        populate: {
          path: "userId",
          select: "-password -__v"
        }
      });

    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC record not found",
        result: {},
      });
    }

    const eligibility = await getTechnicianJobEligibility({ technicianProfileId });
    const kycObj = kyc.toObject();

    // ================= ENFORCE ONLINE PREREQUISITES INTEGRITY =================
    if (kycObj.technicianId) {
      const tech = kycObj.technicianId;
      const canBeOnline =
        tech.trainingCompleted === true &&
        tech.workStatus === "approved";

      if (canBeOnline && kycObj.verificationStatus !== "approved") {
        tech.availability = tech.availability || {};
        tech.availability.isOnline = false;
        console.warn(
          `⚠️ Enforced offline for technician ${technicianProfileId}: KYC status is ${kycObj.verificationStatus}`
        );
      } else if (!canBeOnline) {
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
      delete kycObj.bankDetails.accountNumberHash;
    }

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

    // CHECK BEFORE APPROVAL - Validate all required documents and bank details
    if (status === "approved") {
      const missingFields = [];

      // Check KYC Documents
      if (!kyc.aadhaarNumber) missingFields.push("Aadhaar Number");
      if (!kyc.documents?.aadhaarUrl || kyc.documents.aadhaarUrl.length === 0) missingFields.push("Aadhaar Images");

      if (!kyc.panNumber) missingFields.push("PAN Number");
      if (!kyc.documents?.panUrl || kyc.documents.panUrl.length === 0) missingFields.push("PAN Image");

      if (!kyc.drivingLicenseNumber) missingFields.push("Driving License Number");
      if (!kyc.documents?.dlUrl || kyc.documents.dlUrl.length === 0) missingFields.push("Driving License Images");

      // Check Bank Details
      if (!kyc.bankDetails?.accountHolderName) missingFields.push("Account Holder Name");
      if (!kyc.bankDetails?.bankName) missingFields.push("Bank Name");
      if (!kyc.bankDetails?.accountNumber) missingFields.push("Account Number");
      if (!kyc.bankDetails?.ifscCode) missingFields.push("IFSC Code");
      if (!kyc.bankDetails?.branchName) missingFields.push("Branch Name");

      // If any required field is missing, reject the approval
      if (missingFields.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot approve KYC. Missing required fields",
          result: {
            missingFields: missingFields,
            details: "Please ensure all documents (Aadhaar, PAN, Driving License with images) and bank details (Account Holder Name, Bank Name, Account Number, IFSC Code, Branch Name) are complete before approval."
          },
        });
      }
    }

    kyc.verificationStatus = status;
    kyc.kycVerified = status === "approved";
    kyc.rejectionReason = status === "rejected" ? rejectionReason : null;
    kyc.verifiedAt = new Date();
    kyc.verifiedBy = req.user.userId;

    if (status === "approved") {
      if (kyc.bankDetails && kyc.bankDetails.accountNumber) {
        kyc.bankVerified = true;
        kyc.bankUpdateRequired = false;
        kyc.bankVerifiedAt = new Date();
        kyc.bankVerifiedBy = req.user.userId;
        kyc.bankVerificationStatus = "approved";
        kyc.bankEditableUntil = null;
        kyc.bankRejectionReason = null;
      }
    } else {
      kyc.bankVerified = false;
      kyc.bankUpdateRequired = true;
      kyc.bankVerificationStatus = "pending";
    }

    await kyc.save();

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

    const kycObj = kyc.toObject();
    if (kycObj.bankDetails) {
      delete kycObj.bankDetails.accountNumberHash;
    }

    return res.status(200).json({
      success: true,
      message: `KYC ${status} successfully`,
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

    if (!kyc.bankDetails?.accountNumber) {
      return res.status(400).json({
        success: false,
        message: "No bank details found for this technician",
        result: {},
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

    kyc.bankVerified = verified;
    kyc.bankVerificationStatus = verified ? "approved" : "rejected";
    kyc.bankRejectionReason = verified ? null : bankRejectionReason;
    kyc.bankVerifiedAt = new Date();
    kyc.bankVerifiedBy = req.user.userId;
    kyc.bankUpdateRequired = !verified;
    kyc.bankEditableUntil = verified ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await kyc.save();

    const kycObj = kyc.toObject();
    if (kycObj.bankDetails) {
      delete kycObj.bankDetails.accountNumberHash;
    }

    return res.status(200).json({
      success: true,
      message: `Bank details ${verified ? "verified" : "rejected"} successfully`,
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
