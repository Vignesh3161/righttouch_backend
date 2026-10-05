/**
 * Normalize + validate an Indian mobile number.
 * The +91 / 91 country-code prefix is OPTIONAL:
 *  - "+919876543210" or "919876543210" -> "9876543210"
 *  - "9876543210"                      -> "9876543210" (unchanged)
 *  - "00919876543210" (00 form)        -> "9876543210" (defensive)
 * Returns the clean 10-digit number, or null when invalid.
 * Note: a 10-digit number already starting with "91" (e.g. "9112345678")
 * is a valid mobile and is left untouched.
 */
export const normalizeIndianMobile = (value) => {
  if (value === undefined || value === null) return null;
  let s = String(value).trim().replace(/\s+/g, "");
  if (!s) return null;

  if (s.startsWith("+")) s = s.slice(1);

  // Strip country code (91 or 00) ONLY when the remainder is still a
  // plausible 10-digit mobile — never strip a 10-digit number.
  while ((s.startsWith("91") || s.startsWith("00")) && s.length > 10) {
    s = s.slice(2);
  }

  // Indian mobile: 10 digits, first digit 6-9
  if (!/^[6-9]\d{9}$/.test(s)) return null;
  return s;
};
