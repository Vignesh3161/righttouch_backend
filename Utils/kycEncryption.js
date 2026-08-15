import crypto from "crypto";

/**
 * AES-256-GCM field-level encryption for KYC PII.
 *
 * - GCM provides authenticated encryption: tampered ciphertext is detected
 *   on decrypt (decryptField throws) — callers must NOT swallow that error.
 * - Each TechnicianKyc document gets its own fresh Data Encryption Key (DEK),
 *   wrapped by a master key via Utils/kmsClient.js (envelope encryption).
 * - Encrypted fields are stored as { ciphertext, iv, authTag } (base64) in
 *   the SAME schema paths the codebase already uses, so no downstream code
 *   needs to change. Legacy plaintext documents keep working: helpers check
 *   whether the document has an encryptedDek before decrypting.
 */

export const ALGO = "aes-256-gcm";
export const IV_LENGTH = 12; // GCM standard
export const KEY_LENGTH = 32; // 256-bit

/** Fresh random Data Encryption Key — one per KYC document, never reused. */
export const generateDek = () => crypto.randomBytes(KEY_LENGTH);

/**
 * Encrypt one field value with the document DEK.
 * Returns { ciphertext, iv, authTag } (base64) or null for empty values.
 */
export const encryptField = (plaintext, dek) => {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  if (!dek) return plaintext; // encryption disabled — plaintext passthrough
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
};

/**
 * Decrypt one field. Throws on tampered ciphertext (GCM auth failure) —
 * callers MUST NOT swallow this error silently.
 */
export const decryptField = (encryptedField, dek) => {
  if (!encryptedField || !encryptedField.ciphertext) return null;
  if (!dek) return encryptedField; // plaintext passthrough (legacy / disabled)
  const decipher = crypto.createDecipheriv(
    ALGO,
    dek,
    Buffer.from(encryptedField.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(encryptedField.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedField.ciphertext, "base64")),
    decipher.final(), // throws if authTag doesn't match — tamper detection
  ]);
  return plaintext.toString("utf8");
};

/** True when the value is a stored ciphertext object (not legacy plaintext). */
export const isEncryptedField = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.ciphertext === "string" &&
  typeof value.iv === "string";

/**
 * Transparent read: returns the plaintext whether the stored value is
 * ciphertext (encrypted mode) or legacy plaintext (no DEK).
 */
export const toPlaintext = (value, dek) =>
  isEncryptedField(value) ? decryptField(value, dek) : value;
