/**
 * 📲 COMPLETION OTP SMS SENDER (delivery layer only).
 *
 * Uses the SAME Fast2SMS credentials as auth/notification SMS
 * (`FAST2SMS_API_KEY`), but keeps completion OTP handling separate:
 *  - its own DLT template when COMPLETION_SMS_TEMPLATE_ID is configured,
 *  - otherwise falls back to the approved auth/notification template,
 *  - its own logging/audit/error mapping.
 *
 * Enabled automatically whenever the shared FAST2SMS_API_KEY is present —
 * the same credential auth/notification SMS already use. No separate
 * activation flag is required for completion OTP.
 *
 * Secrecy rules (enforced, tested):
 *  - NEVER log the OTP, the OTP hash, the API key, full phone numbers, or
 *    raw provider payloads. Logs carry a masked phone (last 2 digits) and
 *    the provider's acceptance/request id only.
 *  - `post` (HTTP) is injectable so tests never touch the network.
 */
import { OTP_PATTERN } from "./completionOtp.js";
import sendSms, { AUTH_SMS_TEMPLATE_ID, providerMessageOf } from "./sendSMS.js";

let templateReuseWarned = false;

/** Mask a phone number for logs — last 2 digits only, never the full number. */
export const maskPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length <= 2) return "***";
  return `${"*".repeat(Math.min(digits.length - 2, 8))}${digits.slice(-2)}`;
};

const smsError = (
  message,
  { status = 502, providerStatus = null, providerMessage = null, requestId = null } = {}
) => {
  const err = new Error(message);
  err.name = "SmsError";
  err.provider = "fast2sms";
  err.status = status;
  if (providerStatus != null) err.providerStatus = providerStatus;
  if (providerMessage) err.providerMessage = providerMessage;
  if (requestId) err.requestId = requestId;
  return err;
};

/**
 * Validate completion-SMS delivery WITHOUT printing secrets.
 * The only credential required is the shared FAST2SMS_API_KEY.
 */
export const validateCompletionSmsConfig = () => {
  if (!process.env.FAST2SMS_API_KEY) {
    return {
      configured: false,
      reason: "FAST2SMS_API_KEY is not set (shared auth/notification SMS credential)",
      templateId: null,
      reusesAuthTemplate: false,
    };
  }

  const configuredTemplate = (process.env.COMPLETION_SMS_TEMPLATE_ID || "").trim();
  const templateId = configuredTemplate || AUTH_SMS_TEMPLATE_ID;
  const reusesAuthTemplate = templateId === AUTH_SMS_TEMPLATE_ID;
  if (reusesAuthTemplate) {
    if (!templateReuseWarned) {
      templateReuseWarned = true;
      console.warn(
        "[completionOtp] Using the shared auth/notification DLT template for completion OTP — " +
          "Fast2SMS may reject rapid duplicate sends (error 995, spam detected). " +
          "Set COMPLETION_SMS_TEMPLATE_ID to a dedicated approved completion template when available."
      );
    }
  }
  return {
    configured: true,
    reason: null,
    warning: reusesAuthTemplate
      ? "Using the shared auth/notification template; provider may apply duplicate/spam limits"
      : null,
    templateId,
    reusesAuthTemplate,
  };
};

export const isCompletionSmsActive = () => validateCompletionSmsConfig().configured;

/**
 * Send a completion OTP by SMS using the shared Fast2SMS credential.
 * Throws SmsError with provider details on failure.
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

  const effectiveTemplate = templateId || cfg.templateId || AUTH_SMS_TEMPLATE_ID;

  try {
    const result = await sendSms(local, otpCode, {
      templateId: effectiveTemplate,
      post,
      returnResult: true,
    });
    const requestId = result?.requestId || null;
    console.log(
      `📲 Completion OTP SMS accepted for ${maskPhone(local)}${requestId ? ` request_id=${requestId}` : ""}`
    );
    return { accepted: true, maskedPhone: maskPhone(local), requestId, templateId: effectiveTemplate };
  } catch (error) {
    if (error?.name === "SmsError") throw error;
    throw smsError("Completion SMS failed: provider request failed", {
      status: error?.status || error?.response?.status || 502,
      providerStatus: error?.response?.status || null,
      providerMessage: providerMessageOf(error?.response?.data),
      requestId: error?.response?.data?.request_id || null,
    });
  }
};

export default { sendCompletionSms, validateCompletionSmsConfig, isCompletionSmsActive, maskPhone };
