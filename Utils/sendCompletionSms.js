/**
 * 📲 COMPLETION OTP SMS SENDER (Checkpoint B — delivery layer only).
 *
 * Separate Fast2SMS sender for service-completion OTPs. The existing
 * auth-OTP sender (`Utils/sendSMS.js`) is bound to its own approved DLT
 * template and is left untouched.
 *
 * Activation model (production stays OFF until the DLT template is approved):
 *   COMPLETION_SMS_TEMPLATE_ID=<approved DLT template/message id>
 *   COMPLETION_SMS_ENABLED=true
 * Anything else → sender throws SMS_NOT_CONFIGURED before any provider call.
 *
 * Secrecy rules (enforced, tested):
 *  - NEVER log the OTP, the OTP hash, the API key, full phone numbers, or
 *    raw provider payloads. Logs carry a masked phone (last 2 digits) and
 *    the provider's acceptance boolean only.
 *  - `post` (HTTP) is injectable so tests never touch the network.
 *
 * Crash-safety limitation (documented, not solved here): this is direct
 * post-commit delivery. If the process crashes after the challenge commit
 * but before/while sending, the challenge sits in `pending_delivery`.
 * Recovery: the resend endpoint re-drives delivery idempotently
 * (same-generation guard in `markChallengeDelivering` prevents reviving an
 * old code). Smallest reliable upgrade if loss proves material: a
 * `CompletionSmsOutbox` collection (challengeId, generation, status,
 * attempts, nextRetryAt) + a 1-min sweeper reusing the notification-worker
 * claim pattern — NOT plaintext OTPs in the outbox; re-derive send from
 * the challenge doc (still within TTL) or regenerate the generation.
 */
import axios from "axios";

import { OTP_PATTERN } from "./completionOtp.js";

const SMS_TIMEOUT_MS = 10000;

/** Mask a phone number for logs — last 2 digits only, never the full number. */
export const maskPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length <= 2) return "***";
  return `${"*".repeat(Math.min(digits.length - 2, 8))}${digits.slice(-2)}`;
};

const smsError = (message, { status = 502, providerMessage = null } = {}) => {
  const err = new Error(message);
  err.name = "SmsError";
  err.provider = "fast2sms";
  err.status = status;
  if (providerMessage) err.providerMessage = providerMessage;
  return err;
};

/**
 * Validate completion-SMS configuration WITHOUT printing secrets.
 * Returns { configured: boolean, reason: string|null }.
 */
export const validateCompletionSmsConfig = () => {
  if (process.env.COMPLETION_SMS_ENABLED !== "true") {
    return { configured: false, reason: "COMPLETION_SMS_ENABLED is not 'true' (production activation off)" };
  }
  if (!process.env.COMPLETION_SMS_TEMPLATE_ID || !process.env.COMPLETION_SMS_TEMPLATE_ID.trim()) {
    return { configured: false, reason: "COMPLETION_SMS_TEMPLATE_ID is not set (DLT template pending approval)" };
  }
  if (!process.env.FAST2SMS_API_KEY) {
    return { configured: false, reason: "FAST2SMS_API_KEY is not set" };
  }
  return { configured: true, reason: null };
};

export const isCompletionSmsActive = () => validateCompletionSmsConfig().configured;

/**
 * Send a completion OTP by SMS. Throws SMS_NOT_CONFIGURED / SmsError.
 * `post` defaults to axios.post and is injectable for tests.
 */
export const sendCompletionSms = async (
  phoneNumber,
  otpCode,
  { templateId = null, post = null } = {}
) => {
  const cfg = validateCompletionSmsConfig();
  if (!cfg.configured) {
    throw smsError(`Completion SMS not configured: ${cfg.reason}`, { status: 503 });
  }
  const digits = String(phoneNumber || "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (!/^[0-9]{10}$/.test(local)) {
    throw smsError("Completion SMS failed: invalid recipient phone number", { status: 400 });
  }
  if (!OTP_PATTERN.test(String(otpCode || ""))) {
    throw smsError("Completion SMS failed: invalid OTP format", { status: 500 });
  }

  const url = "https://www.fast2sms.com/dev/bulkV2";
  const payload = {
    route: "dlt",
    sender_id: "RTHUBS",
    message: templateId || process.env.COMPLETION_SMS_TEMPLATE_ID,
    variables_values: String(otpCode),
    numbers: local,
  };
  const doPost = post || axios.post;

  let response;
  try {
    response = await doPost(url, payload, {
      headers: {
        authorization: process.env.FAST2SMS_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: SMS_TIMEOUT_MS,
    });
  } catch (error) {
    // Never include OTP / phone / key / raw payload in the message.
    const apiMessage = error.response?.data?.message || error.response?.data?.error || null;
    throw smsError("Completion SMS failed: provider request failed", {
      status: error.response?.status || 502,
      providerMessage: apiMessage,
    });
  }

  if (!response?.data?.return) {
    throw smsError("Completion SMS failed: provider rejected the request", {
      status: 502,
      providerMessage: response?.data?.message || response?.data?.error || null,
    });
  }

  console.log(`📲 Completion OTP SMS accepted for ${maskPhone(local)}`);
  return { accepted: true, maskedPhone: maskPhone(local) };
};

export default { sendCompletionSms, validateCompletionSmsConfig, isCompletionSmsActive, maskPhone };
