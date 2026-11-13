import mongoose from "mongoose";
import CallLog from "../Schemas/CallLog.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import User from "../Schemas/User.js";

const envBool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const twilioConfig = () => ({
  accountSid: process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID || "",
  authToken: process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN || "",
  maskedNumber:
    process.env.TWILIO_MASKED_NUMBER ||
    process.env.TWILIO_PHONE_NUMBER ||
    process.env.TWILIO_FROM_NUMBER ||
    "",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, ""),
});

export const isTelephonyConfigured = () => {
  const config = twilioConfig();
  return Boolean(config.accountSid && config.authToken && config.maskedNumber);
};

export const manualCallLogsAllowed = () =>
  envBool("ALLOW_MANUAL_CALL_LOGS", process.env.NODE_ENV !== "production");

const toE164 = (value) => {
  const digits = String(value || "").replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return digits.length > 10 ? `+${digits}` : null;
};

const sanitizeLog = (log) => {
  const value = log?.toObject ? log.toObject() : log;
  if (!value) return null;
  return {
    callLogId: value._id,
    bookingId: value.bookingId,
    provider: value.provider,
    status: value.status,
    maskedNumber: value.maskedNumber,
    durationSeconds: value.durationSeconds,
    verified: value.verified,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    createdAt: value.createdAt,
  };
};

const assertCallableBooking = async (bookingId, technicianProfileId) => {
  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    const error = new Error("Invalid booking id");
    error.statusCode = 400;
    throw error;
  }
  const booking = await ServiceBooking.findById(bookingId);
  if (!booking) {
    const error = new Error("Booking not found");
    error.statusCode = 404;
    throw error;
  }
  if (String(booking.technicianId) !== String(technicianProfileId)) {
    const error = new Error("Not your booking");
    error.statusCode = 403;
    throw error;
  }
  if (!["accepted", "on_the_way", "reached"].includes(booking.status)) {
    const error = new Error("Calls can only be placed before the job starts");
    error.statusCode = 409;
    throw error;
  }
  return booking;
};

const getMobileNumbers = async (booking, technicianProfileId) => {
  const [technician, technicianUser, customer] = await Promise.all([
    TechnicianProfile.findById(technicianProfileId).select("userId").lean(),
    TechnicianProfile.findById(technicianProfileId)
      .populate({ path: "userId", select: "mobileNumber" })
      .lean(),
    User.findById(booking.customerId).select("mobileNumber").lean(),
  ]);
  const technicianMobile = toE164(technicianUser?.userId?.mobileNumber);
  const customerMobile = toE164(
    customer?.mobileNumber || booking.addressSnapshot?.phone || booking.addressSnapshot?.mobileNumber
  );
  return {
    technicianMobile,
    customerMobile,
    technicianUserId: technician?.userId || null,
  };
};

export const initiateMaskedCall = async ({ bookingId, technicianProfileId, metadata = null }) => {
  const booking = await assertCallableBooking(bookingId, technicianProfileId);
  const { technicianMobile, customerMobile } = await getMobileNumbers(booking, technicianProfileId);
  if (!technicianMobile || !customerMobile) {
    const error = new Error("A valid technician and customer mobile number are required");
    error.statusCode = 400;
    error.code = "CALL_PARTICIPANT_MOBILE_MISSING";
    throw error;
  }

  const config = twilioConfig();
  const provider = isTelephonyConfigured() ? "twilio" : "manual";
  if (provider === "manual" && !manualCallLogsAllowed()) {
    const error = new Error("Masked calling is not configured");
    error.statusCode = 503;
    error.code = "TELEPHONY_NOT_CONFIGURED";
    throw error;
  }

  const log = await CallLog.create({
    bookingId: booking._id,
    technicianId: technicianProfileId,
    customerId: booking.customerId,
    provider,
    status: provider === "manual" ? "completed" : "initiating",
    maskedNumber: provider === "twilio" ? config.maskedNumber : null,
    verified: false,
    startedAt: new Date(),
    endedAt: provider === "manual" ? new Date() : null,
    metadata,
  });

  if (provider === "manual") {
    return sanitizeLog(log);
  }

  try {
    const twilio = (await import("twilio")).default;
    const client = twilio(config.accountSid, config.authToken);
    const statusCallback = config.publicBaseUrl
      ? `${config.publicBaseUrl}/api/telephony/twilio/status`
      : undefined;
    const call = await client.calls.create({
      to: customerMobile,
      from: config.maskedNumber,
      twiml: `<Response><Dial callerId="${config.maskedNumber}"><Number>${technicianMobile}</Number></Dial></Response>`,
      ...(statusCallback
        ? {
            statusCallback,
            statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
          }
        : {}),
    });
    log.providerCallId = call.sid;
    log.status = "initiated";
    log.metadata = {
      ...(metadata || {}),
      twilioStatus: call.status || "queued",
    };
    await log.save();
    return sanitizeLog(log);
  } catch (error) {
    log.status = "failed";
    log.failureReason = error.message;
    log.endedAt = new Date();
    await log.save().catch(() => {});
    const wrapped = new Error(`Masked call failed: ${error.message}`);
    wrapped.statusCode = 502;
    wrapped.code = "TELEPHONY_PROVIDER_ERROR";
    throw wrapped;
  }
};

export const getCallLogForNoShow = async ({ callLogId, bookingId, technicianId }) => {
  if (!mongoose.Types.ObjectId.isValid(callLogId)) {
    const error = new Error("Invalid call log id");
    error.statusCode = 400;
    error.code = "CALL_LOG_INVALID";
    throw error;
  }
  const log = await CallLog.findOne({
    _id: callLogId,
    bookingId,
    technicianId,
    status: { $in: ["initiated", "ringing", "in_progress", "completed", "busy", "no_answer", "canceled"] },
  }).lean();
  if (!log) {
    const error = new Error("No matching system-logged call attempt was found");
    error.statusCode = 400;
    error.code = "CALL_LOG_INVALID";
    throw error;
  }
  if (!log.verified && !manualCallLogsAllowed()) {
    const error = new Error("The call attempt could not be verified by the telephony provider");
    error.statusCode = 409;
    error.code = "CALL_LOG_UNVERIFIED";
    throw error;
  }
  return log;
};

const TWILIO_STATUS_MAP = {
  queued: "initiated",
  initiated: "initiated",
  ringing: "ringing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no_answer",
  canceled: "canceled",
};

export const handleTwilioStatusCallback = async ({ body = {} }) => {
  const providerCallId = body.CallSid || body.callSid;
  if (!providerCallId) {
    const error = new Error("Missing CallSid");
    error.statusCode = 400;
    throw error;
  }
  const status = TWILIO_STATUS_MAP[String(body.CallStatus || body.callStatus || "").toLowerCase()];
  if (!status) {
    return { updated: false, reason: "unknown_status" };
  }
  const durationSeconds = Math.max(0, Number(body.CallDuration || body.callDuration) || 0);
  const terminal = ["completed", "busy", "failed", "no_answer", "canceled"].includes(status);
  const set = {
    status,
    durationSeconds,
    ...(terminal
      ? {
          endedAt: new Date(),
          verified: status !== "failed",
        }
      : {}),
  };
  if (status === "in_progress" || status === "ringing") {
    set.startedAt = new Date();
  }
  const result = await CallLog.updateOne({ providerCallId }, { $set: set });
  return { updated: result.matchedCount > 0, status };
};

export const validateTwilioSignature = async ({ signature, url, params }) => {
  const config = twilioConfig();
  if (!config.authToken) return true;
  if (!signature) return false;
  const twilio = (await import("twilio")).default;
  return twilio.validateRequest(config.authToken, signature, url, params);
};

export { sanitizeLog };
