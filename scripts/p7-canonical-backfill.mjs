/**
 * P7 canonical-state backfill (Stage B/C) — DRY-RUN BY DEFAULT.
 *
 * Idempotent: re-running changes nothing already migrated. No document
 * ordering dependence, no sleeps, per-doc verification before any write.
 * NEVER logs plaintext PII (only counts + opaque ids).
 *
 *   node scripts/p7-canonical-backfill.mjs                 # dry-run report
 *   node scripts/p7-canonical-backfill.mjs --apply         # write mode
 *   node scripts/p7-canonical-backfill.mjs --apply --only=fcm,wallet,bank
 *
 * Requires MONGO_URI. Bank encryption additionally requires
 * KYC_MASTER_KEY_B64 (refuses otherwise — never rewrites plaintext).
 *
 * Jobs:
 *  fcm    — legacy User/TechnicianProfile.fcmTokens → DeviceToken rows
 *           (canonical identity (userId, deviceId); legacy rows use a
 *           deterministic deviceId `legacy:<sha256(token)[:16]>` so the
 *           same token in both mirrors dedupes to ONE row; skipped when
 *           the token already lives in an active DeviceToken row).
 *  wallet — profiles missing availableBalancePaise WITH zero
 *           WalletTransaction rows and zeroed counters → set paise
 *           counters to 0 (schema establishment, no financial change).
 *           Anything with ledger activity is REPORTED, never auto-written.
 *  bank   — legacy plaintext bank fields (plain strings) → encrypted in
 *           place with the document DEK (round-trip verified in memory
 *           before save). Plaintext fallback reads stay until Stage G.
 *
 * The job functions are exported (import-safe: connecting + exiting only
 * happens when the file is the CLI entrypoint) so the migration contract
 * is covered by automated tests.
 */
import crypto from "crypto";
import mongoose from "mongoose";

const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

export const newReport = () => ({
  fcm: { scanned: 0, created: 0, skipped: 0 },
  wallet: { scanned: 0, zeroFilled: 0, needsReview: 0 },
  bank: { scanned: 0, encrypted: 0, skipped: 0 },
});

export const backfillFcm = async ({ apply }, report, deps) => {
  const { User, TechnicianProfile, DeviceToken } = deps;
  const users = await User.find({ fcmTokens: { $exists: true, $ne: [] } })
    .select("_id role fcmTokens")
    .lean();
  const techs = await TechnicianProfile.find({ fcmTokens: { $exists: true, $ne: [] } })
    .select("_id userId fcmTokens")
    .lean();
  const jobs = [];
  for (const u of users) {
    for (const t of u.fcmTokens || []) {
      if (typeof t !== "string" || t.trim().length <= 10) continue;
      jobs.push({ userId: u._id, role: u.role, token: t });
    }
  }
  for (const t of techs) {
    if (!t.userId) continue;
    for (const tok of t.fcmTokens || []) {
      if (typeof tok !== "string" || tok.trim().length <= 10) continue;
      jobs.push({ userId: t.userId, role: "Technician", token: tok });
    }
  }
  // Dedupe identical (userId, token) pairs — order-independent.
  const seen = new Set();
  const uniq = jobs.filter((j) => {
    const k = `${j.userId}:${sha(j.token)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (const j of uniq) {
    report.fcm.scanned += 1;
    const exists = await DeviceToken.findOne({ userId: j.userId, fcmToken: j.token }).lean();
    if (exists) {
      report.fcm.skipped += 1;
      continue;
    }
    if (!apply) {
      report.fcm.created += 1; // would-create (dry-run)
      continue;
    }
    await DeviceToken.findOneAndUpdate(
      { userId: j.userId, deviceId: `legacy:${sha(j.token).slice(0, 16)}` },
      {
        $set: {
          role: j.role || "Customer",
          fcmToken: j.token,
          isActive: true,
          appVersion: "p7-backfill",
          lastSeenAt: new Date(),
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    report.fcm.created += 1;
  }
  return report.fcm;
};

export const backfillWallet = async ({ apply }, report, deps) => {
  const { TechnicianProfile, WalletTransaction } = deps;
  const cursor = TechnicianProfile.find({
    $or: [{ availableBalancePaise: { $exists: false } }, { availableBalancePaise: null }],
  })
    .select(
      "_id availableBalancePaise reservedBalancePaise reserveBalancePaise outstandingDuesPaise lifetimeEarnedPaise lifetimeWithdrawnPaise"
    )
    .lean()
    .cursor();
  for await (const tech of cursor) {
    report.wallet.scanned += 1;
    const txCount = await WalletTransaction.countDocuments({ technicianId: tech._id });
    const counters = [
      tech.reservedBalancePaise,
      tech.reserveBalancePaise,
      tech.outstandingDuesPaise,
      tech.lifetimeEarnedPaise,
      tech.lifetimeWithdrawnPaise,
    ];
    const allZero = txCount === 0 && counters.every((c) => c == null || c === 0);
    if (!allZero) {
      report.wallet.needsReview += 1;
      console.log(
        `[wallet:review] technician ${tech._id} missing paise with ledger/counters present — manual review, NOT auto-written`
      );
      continue;
    }
    if (!apply) {
      report.wallet.zeroFilled += 1; // would-fill (dry-run)
      continue;
    }
    await TechnicianProfile.updateOne(
      { _id: tech._id },
      {
        $set: {
          availableBalancePaise: 0,
          reservedBalancePaise: 0,
          reserveBalancePaise: 0,
          outstandingDuesPaise: 0,
          lifetimeEarnedPaise: 0,
          lifetimeWithdrawnPaise: 0,
        },
      }
    );
    report.wallet.zeroFilled += 1;
  }
  return report.wallet;
};

const SENSITIVE_BANK_FIELDS = ["accountHolderName", "accountNumber", "ifscCode", "upiId"];
const isLegacyPlaintext = (v) => typeof v === "string" && v.trim().length > 0;

export const backfillBank = async ({ apply }, report, deps) => {
  const { TechnicianKyc, getOrCreateDekForKycDoc, encryptBankDetails, toPlaintext, isEncryptionEnabled } = deps;
  if (!isEncryptionEnabled()) {
    console.log(
      "[bank] SKIPPED — KYC_MASTER_KEY_B64 not configured; refusing to rewrite (would be plaintext passthrough)"
    );
    return report.bank;
  }
  const cursor = TechnicianKyc.find({ bankDetails: { $exists: true, $ne: null } }).cursor();
  for await (const kyc of cursor) {
    const bd = kyc.bankDetails || {};
    const legacyFields = SENSITIVE_BANK_FIELDS.filter((f) => isLegacyPlaintext(bd[f]));
    if (!legacyFields.length) continue;
    report.bank.scanned += 1;
    // In-memory round-trip verification BEFORE any write.
    const dek = await getOrCreateDekForKycDoc(kyc);
    const encrypted = encryptBankDetails(
      Object.fromEntries(legacyFields.map((f) => [f, bd[f]])),
      dek
    );
    let roundTripOk = true;
    for (const f of legacyFields) {
      if (toPlaintext(encrypted[f], dek) !== String(bd[f])) {
        roundTripOk = false;
        break;
      }
    }
    if (!roundTripOk) {
      report.bank.skipped += 1;
      console.log(`[bank:review] technician ${kyc.technicianId} round-trip mismatch — NOT written`);
      continue;
    }
    if (!apply) {
      report.bank.encrypted += 1; // would-encrypt (dry-run)
      continue;
    }
    for (const f of legacyFields) kyc.bankDetails[f] = encrypted[f];
    await kyc.save();
    report.bank.encrypted += 1;
  }
  return report.bank;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) {
  const APPLY = process.argv.includes("--apply");
  const onlyArg = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length);
  const ONLY = new Set(onlyArg ? onlyArg.split(",").map((s) => s.trim()) : ["fcm", "wallet", "bank"]);

  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) {
    console.error("MONGO_URI is required");
    process.exit(2);
  }

  const User = (await import("../modules/identity/models/User.js")).default;
  const TechnicianProfile = (await import("../modules/technician/models/TechnicianProfile.js")).default;
  const DeviceToken = (await import("../modules/notifications/models/DeviceToken.js")).default;
  const TechnicianKyc = (await import("../modules/technician/models/TechnicianKYC.js")).default;
  const WalletTransaction = (await import("../modules/payouts/models/WalletTransaction.js")).default;
  const { getOrCreateDekForKycDoc, encryptBankDetails } = await import(
    "../modules/technician/utils/kycFieldCrypto.js"
  );
  const { toPlaintext } = await import("../modules/technician/utils/kycEncryption.js");
  const { isEncryptionEnabled } = await import("../modules/technician/utils/kmsClient.js");

  await mongoose.connect(MONGO_URI);
  const report = newReport();
  const opts = { apply: APPLY };
  if (ONLY.has("fcm")) await backfillFcm(opts, report, { User, TechnicianProfile, DeviceToken });
  if (ONLY.has("wallet")) await backfillWallet(opts, report, { TechnicianProfile, WalletTransaction });
  if (ONLY.has("bank"))
    await backfillBank(opts, report, {
      TechnicianKyc,
      getOrCreateDekForKycDoc,
      encryptBankDetails,
      toPlaintext,
      isEncryptionEnabled,
    });
  await mongoose.disconnect();
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", report }, null, 2));
  process.exit(0);
}
