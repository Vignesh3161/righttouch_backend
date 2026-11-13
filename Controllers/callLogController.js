import {
  initiateMaskedCall,
  handleTwilioStatusCallback,
  validateTwilioSignature,
} from "../Services/callLogService.js";

const fail = (res, status, message, code = null) =>
  res.status(status).json({
    success: false,
    ...(code ? { code } : {}),
    message,
    result: {},
  });

export const initiateBookingCall = async (req, res) => {
  try {
    if (req.user?.role !== "Technician") {
      return fail(res, 403, "Technician access only");
    }
    const callLog = await initiateMaskedCall({
      bookingId: req.params.id,
      technicianProfileId: req.user?.technicianProfileId,
      metadata: {
        initiatedByUserId: req.user?.userId || null,
        ip: req.ip || null,
      },
    });
    return res.status(201).json({
      success: true,
      message: "Masked call initiated",
      result: callLog,
    });
  } catch (error) {
    return fail(res, error.statusCode || 500, error.message, error.code || null);
  }
};

export const twilioStatusWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-twilio-signature"];
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    const url = publicBaseUrl
      ? `${publicBaseUrl}${req.originalUrl}`
      : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const valid = await validateTwilioSignature({
      signature,
      url,
      params: req.body || {},
    });
    if (!valid) return fail(res, 403, "Invalid Twilio signature");
    await handleTwilioStatusCallback({ body: req.body || {} });
    return res.status(204).send();
  } catch (error) {
    return fail(res, error.statusCode || 500, error.message);
  }
};
