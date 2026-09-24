/**
 * 🔥 FIREBASE CLOUD MESSAGING (FCM) — lazy-init singleton.
 *
 * Reads the service account credentials from (priority order):
 * 1. `FIREBASE_SERVICE_ACCOUNT` or `FCM_SERVICE_ACCOUNT_JSON` (inline JSON string in environment)
 * 2. Individual env vars: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
 * 3. `FCM_SERVICE_ACCOUNT_PATH` (custom path)
 * 4. `config/firebase-credentials.json` (Standard location - takes priority)
 * 5. Other fallback paths in config/ and project root
 *
 * Lazy + guarded: if credential files/variables are missing, the server boots
 * normally and push calls return { skipped: true } — the socket channel remains
 * the live delivery path.
 *
 * PROJECT ID VALIDATION: The backend service account MUST match the project_id
 * in config/google-services.json (mobile app config). Mismatch = push failures.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert, getApp, getApps } from "firebase-admin";
import { getMessaging } from "firebase-admin/messaging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = "fcm";
const REQUIRED_PROJECT_ID = "righttouchmessaging-401e9"; // From config/google-services.json

let app = null;
let initError = null;

const isValidServiceAccount = (sa) => {
  return Boolean(sa && typeof sa === "object" && sa.project_id && sa.private_key && sa.client_email);
};

const validateProjectMatch = (serviceAccount) => {
  if (serviceAccount.project_id !== REQUIRED_PROJECT_ID) {
    const msg = `[FCM CONFIG ERROR] Project ID mismatch!\n` +
      `   Required (mobile app): "${REQUIRED_PROJECT_ID}"\n` +
      `   Configured (backend):  "${serviceAccount.project_id}"\n` +
      `   Push notifications WILL FAIL. Fix config/firebase-credentials.json or env vars.`;
    console.error(`❌ ${msg}`);
    return false;
  }
  return true;
};

const loadServiceAccount = () => {
  // 1. Inline JSON string from env (highest priority - container-friendly)
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (rawJson && typeof rawJson === "string" && rawJson.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawJson);
      if (isValidServiceAccount(parsed)) return parsed;
    } catch (e) {
      console.warn("⚠️ Failed to parse inline FIREBASE_SERVICE_ACCOUNT JSON:", e.message);
    }
  }

  // 2. Individual env vars (common in managed platforms like Render/Railway)
  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY.trim();
    if ((privateKey.startsWith('"') && privateKey.endsWith('"')) || (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
      privateKey = privateKey.slice(1, -1);
    }
    privateKey = privateKey.replace(/\\n/g, "\n");

    const sa = {
      project_id: (process.env.FIREBASE_PROJECT_ID || REQUIRED_PROJECT_ID).trim(),
      client_email: process.env.FIREBASE_CLIENT_EMAIL.trim(),
      private_key: privateKey,
    };
    if (isValidServiceAccount(sa)) return sa;
  }

  // 3. Custom path from env
  if (process.env.FCM_SERVICE_ACCOUNT_PATH) {
    const customPath = path.isAbsolute(process.env.FCM_SERVICE_ACCOUNT_PATH)
      ? process.env.FCM_SERVICE_ACCOUNT_PATH
      : path.join(__dirname, "..", process.env.FCM_SERVICE_ACCOUNT_PATH);
    if (fs.existsSync(customPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(customPath, "utf8"));
        if (isValidServiceAccount(parsed)) return parsed;
      } catch (e) {
        console.warn(`⚠️ Error reading custom FCM path ${customPath}:`, e.message);
      }
    }
  }

  // 4. Standard config location (config/firebase-credentials.json) - RECOMMENDED
  const standardPath = path.join(__dirname, "..", "config", "firebase-credentials.json");
  if (fs.existsSync(standardPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(standardPath, "utf8"));
      if (isValidServiceAccount(parsed)) return parsed;
    } catch (e) {
      console.warn(`⚠️ Error reading ${standardPath}:`, e.message);
    }
  }

  // 5. Legacy root-level firebase-credentials.json (kept for local dev only).
  // NOTE: serverAccount.json / serviceAccount.json fallbacks were REMOVED —
  // that key was committed to git history and must be treated as compromised.
  // Use env vars or config/firebase-credentials.json (git-ignored) instead.
  for (const legacy of ["serverAccount.json", "serviceAccount.json"]) {
    const legacyPath = path.join(__dirname, "..", legacy);
    if (fs.existsSync(legacyPath)) {
      console.error(
        `❌ Compromised legacy credential file still on disk: ${legacy} — ` +
        `it is in git history. Rotate the key in GCP, delete this file, and purge history. ` +
        `It will NOT be loaded.`
      );
    }
  }

  const candidates = [
    path.join(__dirname, "..", "firebase-credentials.json"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        if (isValidServiceAccount(parsed)) {
          return parsed;
        }
      } catch (e) {
        console.warn(`⚠️ Skipping invalid credentials file at ${p}:`, e.message);
      }
    }
  }

  return null;
};

export const getFcmApp = () => {
  if (app) return app;
  if (initError) return null;
  try {
    const serviceAccount = loadServiceAccount();
    if (!serviceAccount) {
      initError = `Firebase service account credentials not found. Expected project_id: "${REQUIRED_PROJECT_ID}". Add config/firebase-credentials.json or set FIREBASE_SERVICE_ACCOUNT env var.`;
      console.warn(`⚠️ ${initError}`);
      return null;
    }

    // Strict project ID validation - fail fast if mismatch
    if (!validateProjectMatch(serviceAccount)) {
      initError = `Project ID mismatch: expected "${REQUIRED_PROJECT_ID}", got "${serviceAccount.project_id}"`;
      return null;
    }

    if (getApps().length) {
      try {
        app = getApp(APP_NAME);
      } catch {
        app = getApp();
      }
    } else {
      app = initializeApp({ credential: cert(serviceAccount) }, APP_NAME);
    }

    console.log(`✅ Firebase Cloud Messaging initialized (Project: ${serviceAccount.project_id})`);
    return app;
  } catch (err) {
    initError = err.message;
    console.error("❌ FCM initialization failed:", err.message);
    return null;
  }
};

export const isFcmEnabled = () => Boolean(getFcmApp());

/** Validate FCM configuration at startup — call from index.js after imports */
export const validateFcmConfig = () => {
  const sa = loadServiceAccount();
  if (!sa) {
    console.warn("⚠️ FCM not configured — push notifications disabled");
    return { valid: false, reason: "no_credentials" };
  }
  if (!validateProjectMatch(sa)) {
    return { valid: false, reason: "project_mismatch", expected: REQUIRED_PROJECT_ID, actual: sa.project_id };
  }
  return { valid: true, projectId: sa.project_id };
};

/**
 * Send a notification to a batch of FCM tokens (multicast).
 * Returns { successCount, failureCount, failedTokens } where failedTokens is
 * [{ token, error }] — callers prune device-not-registered tokens.
 */
export const sendFcmMulticast = async (tokens, { title, body, data = {}, badge = 1 }) => {
  const fcmApp = getFcmApp();
  if (!fcmApp) return { skipped: true, reason: "fcm_not_configured" };

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, failedTokens: [] };
  }

  try {
    const messaging = getMessaging(fcmApp);
    const message = {
      tokens,
      notification: {
        title: title || "RightTouch Alert",
        body: body || "",
      },
      data: Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, String(v ?? "")])
      ),
      android: {
        priority: "high",
        ttl: 86400 * 1000, // 24 hours
        notification: {
          channelId: "righttouch_alerts",
          sound: "default",
          priority: "high",
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        headers: {
          "apns-push-type": "alert",
          "apns-priority": "10",
        },
        payload: {
          aps: {
            alert: {
              title: title || "RightTouch Alert",
              body: body || "",
            },
            badge: Number(badge) || 1,
            sound: "default",
          },
        },
      },
    };

    const resp = await messaging.sendEachForMulticast(message);
    const failedTokens = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        failedTokens.push({ token: tokens[i], error: r.error?.code || r.error?.message || "unknown" });
      }
    });

    if (resp.successCount > 0) {
      console.log(`📱 FCM sent: ${resp.successCount}/${tokens.length} delivered`);
    }
    if (failedTokens.length > 0) {
      console.warn(`⚠️ FCM failures: ${failedTokens.length}/${tokens.length}`, failedTokens.slice(0, 3).map((f) => f.error));
    }

    return { successCount: resp.successCount, failureCount: resp.failureCount, failedTokens };
  } catch (err) {
    console.error("❌ FCM send error:", err.message);
    return { skipped: true, reason: err.message };
  }
};
