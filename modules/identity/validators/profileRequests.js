/**
 * P3 — Profile request validators (identity validation seam).
 *
 * Pure functions extracted VERBATIM from profileService: same allow-lists,
 * same forbidden set, same bank regexes/messages, same normalization.
 * Services call these instead of inline blocks (single source of truth).
 * No new rejections; profileComplete semantics untouched (P4 owns that).
 */

const toFiniteNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const buildLocation = (lat, lng) => {
  if (
    typeof lat === "number" && typeof lng === "number" &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  ) {
    return { type: "Point", coordinates: [lng, lat] };
  }
  return null;
};

const TECHNICIAN_PROFILE_FIELDS = [
  "fname",
  "lname",
  "gender",
  "address",
  "city",
  "state",
  "pincode",
  "latitude",
  "longitude",
  "locality",
  "experienceYears",
  "specialization",
];

const CUSTOMER_PROFILE_FIELDS = ["fname", "lname", "gender", "email"];

const UPDATE_FORBIDDEN_FIELDS = new Set(["password", "status", "userId", "profileComplete"]);

/** complete-profile partitioning (forces profileComplete:true, as today). */
export const partitionCompleteProfileFields = (role, body) => {
  const source = body || {};
  if (role === "Technician") {
    const updateData = {};
    TECHNICIAN_PROFILE_FIELDS.forEach((field) => {
      if (source[field] !== undefined) updateData[field] = source[field];
    });
    const userUpdateData = {};
    if (source.fname !== undefined) userUpdateData.fname = source.fname;
    if (source.lname !== undefined) userUpdateData.lname = source.lname;
    if (source.gender !== undefined) userUpdateData.gender = source.gender;
    if (updateData.latitude !== undefined || updateData.longitude !== undefined) {
      const loc = buildLocation(toFiniteNumber(updateData.latitude), toFiniteNumber(updateData.longitude));
      if (loc) updateData.location = loc;
    }
    updateData.profileComplete = true;
    return { profileUpdate: updateData, userUpdate: userUpdateData };
  }
  const updateData = {};
  CUSTOMER_PROFILE_FIELDS.forEach((field) => {
    if (source[field] !== undefined) updateData[field] = source[field];
  });
  updateData.profileComplete = true;
  return { profileUpdate: updateData, userUpdate: null };
};

/** PUT /me partitioning (forbidden-set filtering for non-technicians). */
export const partitionUpdateProfileFields = (role, body) => {
  const source = body || {};
  const updateData = {};
  if (role === "Technician") {
    TECHNICIAN_PROFILE_FIELDS.forEach((field) => {
      if (source[field] !== undefined) updateData[field] = source[field];
    });
    if (updateData.latitude !== undefined || updateData.longitude !== undefined) {
      const loc = buildLocation(toFiniteNumber(updateData.latitude), toFiniteNumber(updateData.longitude));
      if (loc) updateData.location = loc;
    }
    return updateData;
  }
  Object.keys(source).forEach((k) => {
    if (!UPDATE_FORBIDDEN_FIELDS.has(k) && CUSTOMER_PROFILE_FIELDS.includes(k)) updateData[k] = source[k];
  });
  return updateData;
};

/** Bank-detail format checks (verbatim messages; returns errors array). */
export const validateBankDetailsFormat = (bankDetails) => {
  const source = bankDetails || {};
  const errors = [];
  if (source.accountHolderName && !/^[a-zA-Z\s]{3,}$/.test(source.accountHolderName)) {
    errors.push("Account holder name must be 3+ characters, alphabets and spaces only");
  }
  if (source.bankName && !/^[a-zA-Z\s]{3,}$/.test(source.bankName)) {
    errors.push("Bank name must be 3+ characters, alphabets and spaces only");
  }
  if (source.accountNumber && !/^\d{9,18}$/.test(source.accountNumber)) {
    errors.push("Account number must be 9-18 digits only");
  }
  if (source.ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(source.ifscCode).toUpperCase())) {
    errors.push("Invalid IFSC code format");
  }
  if (source.branchName && String(source.branchName).trim().length < 3) {
    errors.push("Branch name must be at least 3 characters");
  }
  if (source.upiId && !/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(source.upiId)) {
    errors.push("Invalid UPI ID format");
  }
  return errors;
};

/** Bank-detail normalization before encryption (verbatim transforms). */
export const normalizeBankDetailsForSave = (bankDetails, hashAccountNumber, existingHash) => {
  const source = bankDetails || {};
  return {
    accountHolderName: source.accountHolderName
      ? String(source.accountHolderName)
          .toLowerCase()
          .split(" ")
          .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
          .join(" ")
      : source.accountHolderName,
    bankName: source.bankName ? String(source.bankName).trim() : source.bankName,
    accountNumber: source.accountNumber ? String(source.accountNumber).trim() : source.accountNumber,
    accountNumberHash: source.accountNumber
      ? hashAccountNumber(source.accountNumber)
      : existingHash,
    ifscCode: source.ifscCode ? String(source.ifscCode).toUpperCase().trim() : source.ifscCode,
    branchName: source.branchName ? String(source.branchName).trim() : source.branchName,
    upiId: source.upiId ? String(source.upiId).toLowerCase().trim() : source.upiId,
  };
};
