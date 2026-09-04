import { getIo } from "./ioAccess.js";
import { SOCKET_ROOMS } from "./socketConstants.js";
import { sendPushNotification } from "./sendNotification.js";
import sendSms from "./sendSMS.js";

/**
 * Provider adapters. The live, general-purpose channels are socket + push (FCM).
 * SMS is used ONLY for OTP (see `smsAdapter`, invoked solely by the OTP event).
 * WhatsApp/email adapters are present for future use but intentionally NOT
 * wired into general dispatch yet (per deployment constraint).
 */

export const socketAdapter = async ({ recipientId, recipientType, socketEvent, data }) => {
  try {
    const io = getIo();
    if (!io) return { ok: false, permanent: false, error: "no_socket_io" };
    const room =
      recipientType === "technician"
        ? SOCKET_ROOMS.TECHNICIAN(recipientId)
        : recipientType === "admin"
        ? SOCKET_ROOMS.ADMIN_DASHBOARD
        : SOCKET_ROOMS.CUSTOMER(recipientId);
    io.to(room).emit(socketEvent || "notification", data || {});
    return { ok: true };
  } catch (e) {
    return { ok: false, permanent: false, error: e.message };
  }
};

export const pushAdapter = async ({ recipientId, recipientType, title, body, data }) => {
  try {
    const result = await sendPushNotification(
      recipientId,
      { title, body, data: data || {} },
      { recipientType }
    );
    if (result && result.success === false && result.error) {
      const permanent = /not-registered|invalid-argument|unregistered|invalid/i.test(String(result.error));
      return { ok: false, permanent, error: result.error };
    }
    return { ok: true, providerMessageId: result?.success ? "fcm_multicast" : undefined };
  } catch (e) {
    return { ok: false, permanent: false, error: e.message };
  }
};

// OTP-only SMS path (kept separate from general notification dispatch).
export const smsAdapter = async ({ phoneNumber, message }) => {
  try {
    await sendSms(phoneNumber, message);
    return { ok: true };
  } catch (e) {
    const permanent = /invalid|dlr|blocked|permission/i.test(String(e.message));
    return { ok: false, permanent, error: e.message };
  }
};

// Reserved adapters — not used in general dispatch currently.
export const whatsappAdapter = async () => ({
  ok: false,
  permanent: true,
  error: "whatsapp_dispatch_not_enabled",
});
export const emailAdapter = async () => ({
  ok: false,
  permanent: true,
  error: "email_dispatch_not_enabled",
});

export const dispatchByChannel = (channel, payload) => {
  switch (channel) {
    case "socket":
      return socketAdapter(payload);
    case "push":
      return pushAdapter(payload);
    case "sms":
      return smsAdapter(payload);
    case "whatsapp":
      return whatsappAdapter(payload);
    case "email":
      return emailAdapter(payload);
    default:
      return { ok: false, permanent: true, error: `unknown_channel:${channel}` };
  }
};
