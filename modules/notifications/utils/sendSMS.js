import axios from "axios";

export default async function sendSms(phoneNumber, otpCode) {
  try {
    const API_KEY = process.env.FAST2SMS_API_KEY;

    const url = "https://www.fast2sms.com/dev/bulkV2";

    const payload = {
      route: "dlt",
      sender_id: "RTHUBS",
      message: "208466", // Fast2SMS internal message ID
      variables_values: otpCode, // replaces {#var#}
      numbers: phoneNumber, // 10-digit number only
    };

    const response = await axios.post(url, payload, {
      headers: {
        authorization: API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    if (!response.data?.return) {
      const err = new Error("Fast2SMS rejected the request");
      err.name = "SmsError";
      err.provider = "fast2sms";
      err.details = response.data;
      throw err;
    }

    return true;
  } catch (error) {
    const apiData = error.response?.data;

    const providerMessage =
      apiData?.message || apiData?.error || error.message;

    const err = new Error(`SMS failed: ${providerMessage}`);
    err.name = "SmsError";
    err.provider = "fast2sms";
    err.status = error.response?.status || 502;
    err.details = apiData || {};

    throw err;
  }
}

