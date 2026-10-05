import { generateDek, encryptField, toPlaintext } from "./kycEncryption.js";
import { kmsEncryptDek, kmsDecryptDek, isEncryptionEnabled } from "./kmsClient.js";

/**
 * Document-level helpers for transparent KYC field encryption.
 *
 * Rule of thumb:
 *  - Write paths (submit KYC / bank, profile update): encryptField before save.
 *  - Read paths that legitimately need plaintext (self-view, audited admin
 *    full view, masked views, payout fingerprint, fund-account creation):
 *    toPlaintext/decryptIdentityFields/decryptBankDetails.
 *  - Everything else (job matching, eligibility, status checks) only reads
 *    non-sensitive fields (verificationStatus, bankVerified, hashes) and is
 *    untouched.
 */

/**
 * Resolve the DEK for a KYC document — UNWRAP ONLY (read paths).
 * Returns null for legacy (unencrypted) documents and when encryption is
 * disabled; callers must pass plaintext values through unchanged then.
 * Never mutates the document.
 */
export const getDekForKycDoc = async (kycDoc) => {
  if (!kycDoc?.encryptedDek) return null;
  if (!isEncryptionEnabled()) {
    // Key was rotated out / disabled — existing ciphertext can no longer
    // be read. Fail loudly rather than corrupting data.
    throw new Error("KYC encryption is disabled but record contains encrypted data");
  }
  return kmsDecryptDek(kycDoc.encryptedDek);
};

/**
 * Resolve the DEK for a KYC document — CREATE IF MISSING (write paths only).
 * For a new document (or a legacy document being upgraded), generates a
 * fresh DEK, wraps it, and sets doc.encryptedDek so the caller can persist
 * it together with the newly encrypted fields.
 */
export const getOrCreateDekForKycDoc = async (kycDoc) => {
  if (kycDoc?.encryptedDek) {
    return getDekForKycDoc(kycDoc);
  }
  if (!isEncryptionEnabled()) return null; // plaintext passthrough mode
  const dek = generateDek();
  if (kycDoc) kycDoc.encryptedDek = await kmsEncryptDek(dek);
  return dek;
};

/** Encrypt identity numbers (plaintext input → ciphertext objects). */
export const encryptIdentityFields = (aadhaarNumber, panNumber, drivingLicenseNumber, dek) => ({
  aadhaarNumber: encryptField(aadhaarNumber, dek),
  panNumber: encryptField(panNumber, dek),
  drivingLicenseNumber: encryptField(drivingLicenseNumber, dek),
});

/** Encrypt the sensitive bank fields; keeps non-sensitive fields as-is. */
export const encryptBankDetails = (bankDetails, dek) => {
  if (!bankDetails) return bankDetails;
  return {
    ...bankDetails,
    accountHolderName: encryptField(bankDetails.accountHolderName, dek),
    accountNumber: encryptField(bankDetails.accountNumber, dek),
    ifscCode: encryptField(bankDetails.ifscCode, dek),
    upiId: encryptField(bankDetails.upiId, dek),
    // bankName / branchName are NOT sensitive — stay plaintext
  };
};

/** Decrypt identity numbers back to plaintext (handles legacy plaintext too). */
export const decryptIdentityFields = (kycDoc, dek) => ({
  aadhaarNumber: toPlaintext(kycDoc?.aadhaarNumber, dek),
  panNumber: toPlaintext(kycDoc?.panNumber, dek),
  drivingLicenseNumber: toPlaintext(kycDoc?.drivingLicenseNumber, dek),
});

/** Decrypt sensitive bank fields back to plaintext (handles legacy plaintext too). */
export const decryptBankDetails = (bankDetails, dek) => {
  if (!bankDetails || typeof bankDetails !== "object") return bankDetails;
  return {
    ...bankDetails,
    accountHolderName: toPlaintext(bankDetails.accountHolderName, dek),
    accountNumber: toPlaintext(bankDetails.accountNumber, dek),
    ifscCode: toPlaintext(bankDetails.ifscCode, dek),
    upiId: toPlaintext(bankDetails.upiId, dek),
  };
};
