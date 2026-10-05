/**
 * P4 — Canonical bank/KYC status computation (technician domain).
 *
 * Consolidates the REPEATED equivalent checks previously scattered across:
 * - profileService.getMyProfileInternal
 * - technician.js enrichTechnicianWithActivationStatus
 * - technicianWalletController (withdrawal gate)
 * - withdrawalPayoutEngine (payout gate)
 * - technicianKycController.getMyTechnicianKyc normalization
 *
 * Distinct concepts stay distinct (never merged):
 * - "KYC submitted" (a KYC row exists) vs "KYC verified/approved"
 * - "Bank details present" (bankDetails object exists) vs "Bank verified"
 * - "Payout eligible" (activation + bank + workStatus + training) — owned by
 *   activation/eligibility modules, NOT by this file.
 *
 * Pure functions: no Express req/res, no DB writes, no crypto. Callers pass
 * the already-loaded KYC doc (plain, lean, or Mongoose doc). Never logs or
 * returns decrypted PII — only status booleans/strings.
 */

/** KYC approved iff verificationStatus==="approved" OR legacy kycVerified flag. */
export const isKycApproved = (kycDoc) =>
  Boolean(kycDoc && (kycDoc.verificationStatus === "approved" || kycDoc.kycVerified === true));

/** Submission state (verbatim legacy: stored status, else "not_submitted"). */
export const getKycSubmitState = (kycDoc) => {
  if (!kycDoc) return "not_submitted";
  return kycDoc.verificationStatus || "not_submitted";
};

/** Bank verified iff bankVerified===true OR bankVerificationStatus==="approved". */
export const isBankVerified = (kycDoc) =>
  Boolean(
    kycDoc && (kycDoc.bankVerified === true || kycDoc.bankVerificationStatus === "approved")
  );

/** Bank presence: absent when no bankDetails object; else the stored status. */
export const getBankState = (kycDoc) => {
  if (!kycDoc || !kycDoc.bankDetails) return "absent";
  if (isBankVerified(kycDoc)) return "approved";
  return kycDoc.bankVerificationStatus || "pending";
};

/** Bank details present (object exists), regardless of verification. */
export const isBankPresent = (kycDoc) => Boolean(kycDoc && kycDoc.bankDetails);

/**
 * Combined internal state for existing services to consume.
 * Does NOT decide payout eligibility or profile completion.
 */
export const computeBankKycState = (kycDoc) => {
  const kycApproved = isKycApproved(kycDoc);
  const bankVerified = isBankVerified(kycDoc);
  return {
    kycStatus: getKycSubmitState(kycDoc),
    isKycSubmitted: Boolean(kycDoc),
    isKycApproved: kycApproved,
    bankStatus: getBankState(kycDoc),
    isBankPresent: isBankPresent(kycDoc),
    isBankVerified: bankVerified,
  };
};

export default computeBankKycState;
