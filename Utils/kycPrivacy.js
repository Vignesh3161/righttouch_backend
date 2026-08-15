import crypto from "crypto";

/**
 * PII masking + bank-account hashing helpers for the KYC system.
 * Full identity numbers are only ever returned to the owning technician
 * (getMyTechnicianKyc); admin-facing reads must mask them.
 */

export const maskAadhaar = (a) => {
  if (!a) return a;
  const digits = String(a).replace(/\D/g, "");
  if (digits.length < 4) return a;
  return `XXXX-XXXX-${digits.slice(-4)}`;
};

export const maskPan = (p) => {
  if (!p) return p;
  const s = String(p);
  if (s.length < 4) return s;
  return `${"X".repeat(s.length - 4)}${s.slice(-4)}`;
};

export const maskAccount = (acc) => {
  if (!acc) return acc;
  const s = String(acc);
  if (s.length < 4) return s;
  return `${"X".repeat(s.length - 4)}${s.slice(-4)}`;
};

/**
 * Single source of truth for bank-account dedup. Both KYC write paths
 * (submitTechnicianBankDetails and User profile update) MUST use this.
 */
export const hashAccountNumber = (accountNumber) => {
  if (!accountNumber) return null;
  return crypto.createHash("sha256").update(String(accountNumber).trim()).digest("hex");
};

/**
 * Fingerprint of the exact bank/UPI details captured at verification time.
 * Recomputed before every payout and compared against the stored value —
 * if the technician's details changed after verification, the payout is
 * blocked until the account is re-verified.
 */
export const fingerprintBankDetails = (bankDetails = {}) => {
  const parts = [
    String(bankDetails.accountNumber || "").trim(),
    String(bankDetails.ifscCode || "").toUpperCase().trim(),
    String(bankDetails.upiId || "").toLowerCase().trim(),
  ];
  if (!parts[0] && !parts[2]) return null;
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
};
