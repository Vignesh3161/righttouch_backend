import crypto from "crypto";

/**
 * Master-key wrapper for the KYC DEKs (envelope encryption).
 *
 * Production: swap the body of kmsEncryptDek/kmsDecryptDek for real cloud
 * KMS calls (AWS KMS / GCP KMS) — NOTHING else in the codebase changes.
 *
 * Interim: a single 32-byte master key from a secrets manager, injected via
 * KYC_MASTER_KEY_B64 by the deploy pipeline (never committed to .env in
 * the repo — .env here is local dev only).
 *
 * Encryption is DISABLED (plaintext passthrough) until KYC_MASTER_KEY_B64 is
 * configured, so a deployment without the key never breaks the app — it
 * just degrades to the previous behavior and logs a warning at boot.
 */

export const isEncryptionEnabled = () => {
  const b64 = process.env.KYC_MASTER_KEY_B64;
  if (!b64) return false;
  const key = Buffer.from(b64, "base64");
  return key.length === 32;
};

const getMasterKey = () => {
  if (!isEncryptionEnabled()) {
    throw new Error("KYC_MASTER_KEY_B64 not configured — cannot wrap DEK");
  }
  return Buffer.from(process.env.KYC_MASTER_KEY_B64, "base64");
};

/**
 * Wrap a DEK: [iv(12) | authTag(16) | ciphertext] base64.
 */
export const kmsEncryptDek = async (dek) => {
  const master = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", master, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
};

/**
 * Unwrap a DEK. Throws on malformed blob or tamper (GCM auth failure).
 */
export const kmsDecryptDek = async (encryptedDekB64) => {
  if (!encryptedDekB64) return null;
  const master = getMasterKey();
  const blob = Buffer.from(encryptedDekB64, "base64");
  if (blob.length < 28) throw new Error("Malformed wrapped DEK");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", master, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
};
