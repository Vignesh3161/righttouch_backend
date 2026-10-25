import axios from "axios";

// Approved DLT template used by the auth OTP flow and shared notification SMS.
// Service-completion OTP falls back to this template when no dedicated
// COMPLETION_SMS_TEMPLATE_ID is configured. Exported so completion-SMS
// diagnostics can flag accidental reuse.
export const AUTH_SMS_TEMPLATE_ID = "208466";
const SMS_TIMEOUT_MS = 10000;

/** Normalize Fast2SMS `message`/`error` (string or array) for safe logging. */
export const providerMessageOf = (data) => {
  const raw = data?.message || data?.error;
  if (Array.isArray(raw)) return raw.filter(Boolean).join("; ").slice(0, 300);
  return raw ? String(raw).slice(0, 300) : null;
};

const smsError = (
  message,
  { status = 502, providerStatus = null, providerMessage = null, requestId = null, details = null } = {}
) => {
  const err = new Error(message);
  err.name = "SmsError";
  err.provider = "fast2sms";
  err.status = status;
  if (providerStatus != null) err.providerStatus = providerStatus;
  if (providerMessage) err.providerMessage = providerMessage;
  if (requestId) err.requestId = requestId;
  if (details) err.details = details;
  return err;
};

/**
 * Shared Fast2SMS DLT sender. Auth OTP, notification SMS, and service
 * completion OTP all use the same FAST2SMS_API_KEY. Only the DLT template
 * (and therefore the message wording) differs per flow.
 *
 * `post` is injectable so tests never touch the network. Auth/notification
 * callers keep the original `true` return; `returnResult` opts into
 * `{ accepted, requestId }` for completion-SMS logging.
 */
export default async function sendSms(
  phoneNumber,
  otpCode,
  { templateId = AUTH_SMS_TEMPLATE_ID, post = null, returnResult = false } = {}
) {
  const API_KEY = process.env.FAST2SMS_API_KEY;
  if (!API_KEY) {
    throw smsError("SMS failed: FAST2SMS_API_KEY is not set", { status: 503 });
  }

  const doPost = post || axios.post;
  const url = "https://www.fast2sms.com/dev/bulkV2";
  const payload = {
    route: "dlt",
    sender_id: "RTHUBS",
    message: templateId,
    variables_values: otpCode,
    numbers: phoneNumber,
  };

  try {
    const response = await doPost(url, payload, {
      headers: {
        authorization: API_KEY,
        "Content-Type": "application/json",
      },
      timeout: SMS_TIMEOUT_MS,
    });

    if (!response?.data?.return) {
      throw smsError("Fast2SMS rejected the request", {
        status: 502,
        providerStatus: response?.status || null,
        providerMessage: providerMessageOf(response?.data),
        requestId: response?.data?.request_id || null,
        details: response?.data || null,
      });
    }

    if (!returnResult) return true;
    return { accepted: true, requestId: response?.data?.request_id || null };
  } catch (error) {
    if (error?.name === "SmsError") throw error;
    const apiData = error.response?.data;
    throw smsError(`SMS failed: ${providerMessageOf(apiData) || error.message}`, {
      status: error.response?.status || 502,
      providerStatus: error.response?.status || null,
      providerMessage: providerMessageOf(apiData),
      requestId: apiData?.request_id || null,
      details: apiData || null,
    });
  }
}
