/**
 * 🔥 FIREBASE CLOUD MESSAGING (FCM) — lazy-init singleton.
 *
 * Reads the service account credentials from:
 * 1. `FIREBASE_SERVICE_ACCOUNT` or `FCM_SERVICE_ACCOUNT_JSON` (inline JSON string in environment)
 * 2. `FCM_SERVICE_ACCOUNT_PATH` (custom path)
 * 3. `config/firebase-credentials.json` (Standard location)
 * 4. `serverAccount.json` or `serviceAccount.json` in project root
 *
 * Lazy + guarded: if credential files/variables are missing, the server boots
 * normally and push calls return { skipped: true } — the socket channel remains
 * the live delivery path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert, getApp, getApps } from "firebase-admin";
import { getMessaging } from "firebase-admin/messaging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = "fcm";

let app = null;
let initError = null;

const isValidServiceAccount = (sa) => {
  return Boolean(sa && typeof sa === "object" && sa.project_id && sa.private_key && sa.client_email);
};

const loadServiceAccount = () => {
  // 1. Direct environment variable containing raw JSON string
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (rawJson && typeof rawJson === "string" && rawJson.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawJson);
      if (isValidServiceAccount(parsed)) return parsed;
    } catch (e) {
      console.warn("⚠️ Failed to parse inline FIREBASE_SERVICE_ACCOUNT JSON:", e.message);
    }
  }

  // 2. Custom path from env
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

  // 3. Default fallback paths in config/ and project root
  const candidates = [
    path.join(__dirname, "..", "config", "firebase-credentials.json"),
    path.join(__dirname, "..", "serverAccount.json"),
    path.join(__dirname, "..", "serviceAccount.json"),
    path.join(__dirname, "..", "firebase-service-account.json"),
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
      initError = "Firebase service account credentials not found or missing private_key — FCM push disabled";
      console.warn(`⚠️ ${initError}`);
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

    console.log(`✅ Firebase Cloud Messaging initialized successfully (Project: ${serviceAccount.project_id || "default"})`);
    return app;
  } catch (err) {
    initError = err.message;
    console.error("❌ FCM initialization failed:", err.message);
    return null;
  }
};

export const isFcmEnabled = () => Boolean(getFcmApp());

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
