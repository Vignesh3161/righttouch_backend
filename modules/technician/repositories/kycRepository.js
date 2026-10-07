/**
 * P3 — KYC repository (technician-owned persistence seam).
 *
 * Module ownership is respected: this file lives in the Technician module
 * next to the TechnicianKYC model. It covers the KYC persistence used by
 * identity/profile flows (bank pipeline, profile reads, delete cascades)
 * and the admin-list DEK lookup. KYC business rules, encryption, and the
 * Technician module's own KYC controller are untouched (Task 6).
 */
import TechnicianKyc from "../models/TechnicianKYC.js";

const withSession = (options, query) =>
  options?.session ? query.session(options.session) : query;

export const findByTechnicianId = (technicianId, select, options = {}) => {
  let query = TechnicianKyc.findOne({ technicianId });
  if (select) query = query.select(select);
  return withSession(options, query);
};

/** Unsaved shell for technicians without a KYC row (persisted later via saveKycDocument). */
export const newKycShell = (technicianId) => new TechnicianKyc({ technicianId });

/** Persist a (possibly encrypted-mutated) KYC document. */
export const saveKycDocument = (kycDoc, options = {}) =>
  options?.session ? kycDoc.save({ session: options.session }) : kycDoc.save();

/**
 * P7 explicit compat: hash lookup (canonical) OR legacy plaintext lookup
 * (pre-encryption documents). The plaintext arm fires only for unmigrated
 * rows; run scripts/p7-canonical-backfill.mjs to shrink that set. Never
 * remove the plaintext arm before backfill verification (Stage G).
 */
export const findDuplicateAccount = ({ accountNumberHash, accountNumber, excludeTechnicianId }, options = {}) =>
  withSession(
    options,
    TechnicianKyc.findOne({
      $or: [
        { "bankDetails.accountNumberHash": accountNumberHash },
        { "bankDetails.accountNumber": String(accountNumber).trim() },
      ],
      technicianId: { $ne: excludeTechnicianId },
    })
  );

/** Admin-list support: encrypted DEKs for a technician set (crypto stays in services). */
export const findEncryptedDeksByTechnicianIds = (technicianIds, options = {}) =>
  withSession(
    options,
    TechnicianKyc.find({ technicianId: { $in: technicianIds } })
      .select("technicianId encryptedDek")
      .lean()
  );

export const deleteByTechnicianId = (technicianId, options = {}) =>
  withSession(options, TechnicianKyc.deleteOne({ technicianId }));
