/**
 * 🔥 FIREBASE CLOUD MESSAGING (FCM) — lazy-init singleton.
 *
 * Reads the service account JSON from the repo root (serverAccount.json) —
 * the file already exists in production. Override the path with
 * FCM_SERVICE_ACCOUNT_PATH if it lives elsewhere.
 *
 * Lazy + guarded: if the credential file is missing or the project is not
 * configured for FCM, the server boots normally and push calls return
 * { skipped: true } — the socket channel remains the live delivery path.
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

const serviceAccountPath = () =>
  process.env.FCM_SERVICE_ACCOUNT_PATH || path.join(__dirname, "..", "serverAccount.json");

export const getFcmApp = () => {
  if (app) return app;
  if (initError) return null;
  try {
    const filePath = serviceAccountPath();
    if (!fs.existsSync(filePath)) {
      initError = `${filePath} not found — FCM disabled`;
      console.warn(`⚠️ ${initError}`);
      return null;
    }
    const serviceAccount = JSON.parse(fs.readFileSync(filePath, "utf8"));
    app = getApps().length ? getApp(APP_NAME) || getApp() : initializeApp({ credential: cert(serviceAccount) }, APP_NAME);
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
export const sendFcmMulticast = async (tokens, { title, body, data = {} }) => {
  const fcmApp = getFcmApp();
  if (!fcmApp) return { skipped: true, reason: "fcm_not_configured" };

  try {
    const messaging = getMessaging(fcmApp);
    const message = {
      tokens,
      notification: { title: title || "RightTouch", body: body || "" },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v ?? "")])
      ),
      android: { priority: "high", ttl: 0 },
      apns: {
        headers: { "apns-push-type": "background", "apns-priority": "5" },
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