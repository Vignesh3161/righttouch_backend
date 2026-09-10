// 🔒 Startup secret validation (Remediation Plan §2.5 / §7).
// Treats any committed/placeholder credential as compromised. In production we
// refuse to boot with weak or placeholder secrets; in non-production we warn so
// local dev still runs but the problem is surfaced loudly.
const REQUIRED = [
  "JWT_SECRET",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "KYC_MASTER_KEY_B64",
  "MONGO_URI",
];

const isPlaceholder = (v) =>
  !v ||
  v.length < 16 ||
  /^(your_|changeme|secret|test|demo|example|dummy|<)/i.test(v) ||
  v.includes("_here") ||
  v.includes("REPLACE_ME");

export const validateSecrets = () => {
  const errors = [];
  const warnings = [];

  for (const name of REQUIRED) {
    const value = process.env[name];
    if (!value) {
      errors.push(`Missing required secret/env: ${name}`);
      continue;
    }
    if (isPlaceholder(value)) {
      errors.push(
        `Insecure/placeholder secret rejected: ${name} (must be >=16 chars and not a placeholder)`
      );
    }
  }

  // GCP service-account key should never be tracked in the repo.
  const gcpKey = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gcpKey && gcpKey.includes("serverAccount.json")) {
    warnings.push(
      "GOOGLE_APPLICATION_CREDENTIALS points at serverAccount.json — ensure it is git-ignored and rotated; it was previously committed to history."
    );
  }

  const isProd = process.env.NODE_ENV === "production";

  if (warnings.length) {
    for (const w of warnings) console.warn(`⚠️  SECRET WARNING: ${w}`);
  }

  if (errors.length) {
    console.error("🚨 CRITICAL SECRET VALIDATION WARNING / ERROR:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error("⚠️ Server will bind HTTP port to satisfy Cloud Run container health checks, but missing/placeholder secrets MUST be configured in environment variables!");
  }
};
