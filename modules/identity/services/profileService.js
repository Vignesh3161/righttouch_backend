import { getDekForKycDoc, getOrCreateDekForKycDoc, encryptBankDetails, decryptBankDetails } from "../../technician/utils/kycFieldCrypto.js";
import { hashAccountNumber } from "../../technician/utils/kycPrivacy.js";
import { toPlaintext } from "../../technician/utils/kycEncryption.js";
import { kmsDecryptDek } from "../../technician/utils/kmsClient.js";
// P3 seams: persistence via repositories, field rules via validators.
// Crypto/business rules stay here (Task 6: no KYC rewrite).
import * as userRepo from "../repositories/userRepository.js";
import * as profileRepo from "../repositories/profileRepository.js";
import * as kycRepo from "../../technician/repositories/kycRepository.js";
import {
  partitionCompleteProfileFields,
  partitionUpdateProfileFields,
  validateBankDetailsFormat,
  normalizeBankDetailsForSave,
} from "../validators/profileRequests.js";
import { computeProfileComplete } from "../utils/profileCompletion.js";
import { computeBankKycState } from "../../technician/utils/bankKycStatus.js";

/**
 * Internal Profile Service
 * Handles user profile retrieval, update, completion, and admin user list aggregation.
 *
 * P3: persistence via repositories, field rules via validators. Pure helpers
 * (toFiniteNumber/buildLocation) live in validators/profileRequests.js.
 */

/**
 * Decrypts KYC identity and bank fields for admin listing.
 */
const decryptAdminUserList = async (users) => {
  const techUsers = users.filter((u) => u.technicianId);
  if (techUsers.length === 0) return;
  const kycDocs = await kycRepo.findEncryptedDeksByTechnicianIds(
    techUsers.map((u) => u.technicianId)
  );
  const dekByTech = new Map();
  for (const doc of kycDocs) {
    if (!doc.encryptedDek) continue;
    try {
      const dek = await kmsDecryptDek(doc.encryptedDek);
      dekByTech.set(doc.technicianId.toString(), dek);
    } catch (e) {
      console.error(`Failed to decrypt DEK for technician ${doc.technicianId}:`, e.message);
    }
  }
  for (const u of users) {
    const dek = u.technicianId ? dekByTech.get(u.technicianId.toString()) : undefined;
    if (!dek) continue;
    if (u.kyc) {
      u.kyc.aadhaarNumber = toPlaintext(u.kyc.aadhaarNumber, dek);
      u.kyc.panNumber = toPlaintext(u.kyc.panNumber, dek);
      u.kyc.drivingLicenseNumber = toPlaintext(u.kyc.drivingLicenseNumber, dek);
    }
    if (u.bankDetails) {
      u.bankDetails.accountHolderName = toPlaintext(u.bankDetails.accountHolderName, dek);
      u.bankDetails.ifscCode = toPlaintext(u.bankDetails.ifscCode, dek);
      u.bankDetails.upiId = toPlaintext(u.bankDetails.upiId, dek);
    }
  }
};

/**
 * Retrieves profile for authenticated user.
 */
export const getMyProfileInternal = async ({ userId, role }) => {
  if (!userId || !role) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "UNAUTHORIZED";
    throw err;
  }

  if (role === "Technician") {
    // P3: read via the profile/KYC repositories (same populated shape).
    const profile = await profileRepo.findTechnicianWithUser(userId);

    if (!profile) {
      const err = new Error("Profile not found");
      err.statusCode = 404;
      err.code = "PROFILE_NOT_FOUND";
      throw err;
    }

    const result = profile.toObject();
    const kyc = await kycRepo.findByTechnicianId(
      profile._id,
      "bankDetails bankVerified bankVerificationStatus verificationStatus kycVerified bankUpdateRequired encryptedDek"
    );

    // P4: canonical bank/KYC state (verbatim semantics: approved iff
    // verificationStatus==="approved" OR legacy boolean flag).
    const bankKyc = computeBankKycState(kyc);
    const isKycApproved = bankKyc.isKycApproved;
    const isBankApproved = bankKyc.isBankVerified;
    const isTrainingDone = Boolean(profile.trainingCompleted);

    result.kycVerified = isKycApproved;
    result.verificationStatus = kyc?.verificationStatus || "pending";
    result.isBankVerified = isBankApproved;
    result.bankVerified = isBankApproved;
    result.bankVerificationStatus = kyc?.bankVerificationStatus || "pending";
    result.trainingCompleted = isTrainingDone;
    result.isActiveTechnician = isKycApproved && (isTrainingDone || profile.workStatus === "approved");

    if (kyc && kyc.bankDetails) {
      try {
        const dek = await getDekForKycDoc(kyc);
        result.bankDetails = decryptBankDetails(kyc.bankDetails, dek);
      } catch (decErr) {
        console.error("Error decrypting bank details in getMyProfileInternal:", decErr.message);
      }
      result.bankUpdateRequired = kyc.bankUpdateRequired || false;
    }
    // P7: response derives profileComplete from the canonical computation
    // (populated owner names are already loaded — no extra query). A stale
    // persisted mirror can no longer override the canonical value here.
    const ownerUser =
      result.userId && typeof result.userId === "object" ? result.userId : null;
    result.profileComplete = computeProfileComplete({
      role: "Technician",
      user: ownerUser,
      technicianProfile: result,
    });
    return result;
  } else {
    const user = await userRepo.findByIdLean(userId, "-password");
    if (!user) {
      const err = new Error("User not found");
      err.statusCode = 404;
      err.code = "USER_NOT_FOUND";
      throw err;
    }
    // P7: same canonical derivation for customers (already-loaded doc).
    user.profileComplete = computeProfileComplete({ role, user });
    return user;
  }
};

/**
 * Complete user profile.
 */
export const completeProfileInternal = async ({ userId, role, body }) => {
  if (!userId || !role) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "UNAUTHORIZED";
    throw err;
  }

  // P3: field partitioning via the validation seam (byte-identical sets).
  // P4: profileComplete via the canonical computation (no forced-true bypass).
  const { profileUpdate, userUpdate } = partitionCompleteProfileFields(role, body);

  if (role === "Technician") {
    // Merge incoming fields over the stored profile + user names so the
    // canonical technician heuristic (name + address + city +
    // specialization + locality + skills) is evaluated on effective values.
    const [storedProfile, storedUser] = await Promise.all([
      profileRepo.findByUserId(userId, null, { lean: true }),
      userRepo.findByIdLean(userId, "fname lname mobileNumber"),
    ]);
    const effectiveUser = {
      fname: userUpdate?.fname !== undefined ? userUpdate.fname : storedUser?.fname,
      lname: userUpdate?.lname !== undefined ? userUpdate.lname : storedUser?.lname,
      mobileNumber: storedUser?.mobileNumber,
    };
    const effectiveTech = { ...(storedProfile || {}), ...profileUpdate };
    profileUpdate.profileComplete = computeProfileComplete({
      role,
      user: effectiveUser,
      technicianProfile: effectiveTech,
    });

    if (userUpdate && Object.keys(userUpdate).length > 0) {
      await userRepo.updateUserById(userId, userUpdate, { new: true, runValidators: true });
    }

    const updated = await profileRepo.updateByUserId(
      userId,
      profileUpdate,
      { new: true, runValidators: true },
      { select: "-password" }
    );

    return updated || {};
  } else {
    // Customer: canonical heuristic (fname + mobileNumber). Callers that
    // supply profile fields (complete-profile sends fname) still yield true,
    // preserving the existing contract without a forced-true bypass.
    const storedUser = await userRepo.findByIdLean(userId, "fname lname mobileNumber");
    const effectiveUser = {
      fname: profileUpdate.fname !== undefined ? profileUpdate.fname : storedUser?.fname,
      lname: profileUpdate.lname !== undefined ? profileUpdate.lname : storedUser?.lname,
      mobileNumber: storedUser?.mobileNumber,
    };
    profileUpdate.profileComplete = computeProfileComplete({ role, user: effectiveUser });

    const updated = await userRepo.updateUserById(
      userId,
      profileUpdate,
      { new: true, runValidators: true },
      { select: "-password" }
    );

    return updated || {};
  }
};

/**
 * Update user profile (including bank details for technicians).
 */
export const updateMyProfileInternal = async ({ userId, role, body }) => {
  if (!userId || !role) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "UNAUTHORIZED";
    throw err;
  }

  if (role === "Technician" && body?.bankDetails) {
    const technicianProfile = await profileRepo.findByUserId(userId);
    if (!technicianProfile) {
      const err = new Error("Technician profile not found");
      err.statusCode = 404;
      err.code = "PROFILE_NOT_FOUND";
      throw err;
    }

    const bankDetails = body.bankDetails || {};
    // P3: KYC reads/writes via the technician-owned repository.
    let kyc = await kycRepo.findByTechnicianId(technicianProfile._id);
    if (!kyc) {
      kyc = kycRepo.newKycShell(technicianProfile._id);
    }

    if (kyc.bankVerified && !kyc.bankUpdateRequired) {
      const err = new Error("Bank details are verified and cannot be edited");
      err.statusCode = 403;
      err.code = "BANK_EDIT_BLOCKED";
      throw err;
    }

    // P3: format rules via the validation seam (verbatim messages).
    const errors = validateBankDetailsFormat(bankDetails);

    if (errors.length) {
      const err = new Error("Invalid bank details");
      err.statusCode = 400;
      err.code = "VALIDATION_ERROR";
      err.details = { errors };
      throw err;
    }

    if (bankDetails.accountNumber) {
      const accountNumberHash = hashAccountNumber(bankDetails.accountNumber);
      const dup = await kycRepo.findDuplicateAccount({
        accountNumberHash,
        accountNumber: bankDetails.accountNumber,
        excludeTechnicianId: technicianProfile._id,
      });
      if (dup) {
        const err = new Error("Account number already registered with another technician");
        err.statusCode = 400;
        err.code = "DUPLICATE_ACCOUNT";
        throw err;
      }
    }

    // P3: normalization via the validation seam (verbatim transforms).
    const processed = normalizeBankDetailsForSave(
      bankDetails,
      hashAccountNumber,
      kyc.bankDetails?.accountNumberHash
    );

    const dek = await getOrCreateDekForKycDoc(kyc);
    kyc.bankDetails = { ...(kyc.bankDetails || {}), ...encryptBankDetails(processed, dek) };
    kyc.bankVerified = false;
    kyc.bankUpdateRequired = false;
    kyc.bankVerificationStatus = "pending";
    kyc.bankEditableUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await kycRepo.saveKycDocument(kyc);
  }

  if (role === "Technician") {
    // P3: field partitioning via the validation seam (byte-identical set).
    const updateData = partitionUpdateProfileFields(role, body);
    const updated = await profileRepo.updateByUserId(
      userId,
      updateData,
      { new: true, runValidators: true },
      { select: "-password" }
    );
    return updated || {};
  } else {
    // P3: forbidden-set filtering via the validation seam (byte-identical).
    const updateData = partitionUpdateProfileFields(role, body);

    // P4: canonical customer computation (was: finalFname && mobileNumber → true).
    const currentUser = await userRepo.findByIdLean(userId, "fname lname mobileNumber");
    const effectiveUser = {
      fname: updateData.fname !== undefined ? updateData.fname : currentUser?.fname,
      lname: updateData.lname !== undefined ? updateData.lname : currentUser?.lname,
      mobileNumber: currentUser?.mobileNumber,
    };
    if (computeProfileComplete({ role, user: effectiveUser })) {
      updateData.profileComplete = true;
    }

    const updated = await userRepo.updateUserById(
      userId,
      updateData,
      { new: true, runValidators: true },
      { select: "-password" }
    );

    return updated || {};
  }
};

/**
 * Admin list users by role with optimized aggregations.
 */
export const getAllUsersInternal = async ({ role, search }) => {
  if (!role) {
    const err = new Error("Role is required");
    err.statusCode = 400;
    throw err;
  }

  const searchMatch = {};
  if (search && search.trim().length >= 2) {
    const searchRegex = { $regex: search.trim(), $options: "i" };
    searchMatch.$or = [
      { mobileNumber: searchRegex },
      { fname: searchRegex },
      { lname: searchRegex },
      { email: searchRegex },
    ];
  }

  let users;

  if (role === "Customer") {
    users = await userRepo.aggregateCustomerDirectory(searchMatch);
  } else if (role === "Technician") {
    users = await userRepo.aggregateTechnicianDirectory(searchMatch);

    await decryptAdminUserList(users);
  } else {
    users = await userRepo.findUsersByRole(role, searchMatch);
  }

  return users;
};

/**
 * Admin get user by ID.
 */
export const getUserByIdInternal = async ({ role, id }) => {
  if (!role || !id) {
    const err = new Error("Role and id are required");
    err.statusCode = 400;
    throw err;
  }

  const user = await userRepo.findByRoleAndId(role, id);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  return user;
};
