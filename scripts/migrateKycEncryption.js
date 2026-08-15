import "dotenv/config";
import mongoose from "mongoose";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import { isEncryptionEnabled } from "../Utils/kmsClient.js";
import {
  getOrCreateDekForKycDoc,
  encryptIdentityFields,
  encryptBankDetails,
} from "../Utils/kycFieldCrypto.js";
import { isEncryptedField } from "../Utils/kycEncryption.js";

/**
 * One-time backfill: encrypt legacy PLAINTEXT KYC fields at rest.
 *
 *   node scripts/migrateKycEncryption.js
 *
 * Requirements (in .env):
 *   - MONGO_URI
 *   - KYC_MASTER_KEY_B64  (32 random bytes, base64) — the script REFUSES to
 *     run without it, so it can never "migrate" to plaintext mode.
 *
 * Idempotent: documents that already carry an encryptedDek are skipped.
 * Documents with a mix of plaintext + ciphertext are skipped for manual
 * review (should not exist).
 */

const SENSITIVE_IDENTITY = ["aadhaarNumber", "panNumber", "drivingLicenseNumber"];
const SENSITIVE_BANK = ["accountHolderName", "accountNumber", "ifscCode", "upiId"];

const run = async () => {
  if (!isEncryptionEnabled()) {
    console.error(
      "✋ KYC_MASTER_KEY_B64 is not configured (or not 32 bytes). Refusing to run — " +
      "migration must encrypt, not just rewrite plaintext."
    );
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error("✋ MONGO_URI missing from .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000,
  });
  console.log("🔌 Connected to MongoDB\n");

  let encrypted = 0;
  let already = 0;
  let mixed = 0;
  let errors = 0;

  const cursor = TechnicianKyc.find({}).cursor();
  const docs = [];
  for await (const doc of cursor) docs.push(doc);

  console.log(`📄 Found ${docs.length} KYC document(s)\n`);

  for (const doc of docs) {
    try {
      if (doc.encryptedDek) {
        already++;
        continue;
      }

      const anyIdentityEncrypted = SENSITIVE_IDENTITY.some((f) => isEncryptedField(doc[f]));
      const bank = doc.bankDetails || {};
      const anyBankEncrypted = SENSITIVE_BANK.some((f) => isEncryptedField(bank[f]));

      if (anyIdentityEncrypted || anyBankEncrypted) {
        mixed++;
        console.log(`⚠️  Skipping ${doc._id} — mixed plaintext/ciphertext, review manually`);
        continue;
      }

      const dek = await getOrCreateDekForKycDoc(doc); // generates fresh DEK + sets doc.encryptedDek
      doc.set(
        encryptIdentityFields(
          doc.aadhaarNumber,
          doc.panNumber,
          doc.drivingLicenseNumber,
          dek
        )
      );
      if (bank && typeof bank === "object") {
        doc.bankDetails = encryptBankDetails(bank, dek);
      }
      await doc.save();
      encrypted++;
    } catch (err) {
      errors++;
      console.error(`❌ Failed ${doc._id}: ${err.message}`);
    }
  }

  console.log("\n── Migration summary ──");
  console.log(`✅ Encrypted:            ${encrypted}`);
  console.log(`⏭️  Already encrypted:    ${already}`);
  console.log(`⚠️  Mixed (manual check): ${mixed}`);
  console.log(`❌ Errors:               ${errors}`);

  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
};

run().catch(async (err) => {
  console.error("💥 Migration crashed:", err);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
