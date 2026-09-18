import { getIo } from "./ioAccess.js";
import { SOCKET_ROOMS } from "./socketConstants.js";
import { sendPushNotification } from "./sendNotification.js";
import sendSms from "./sendSMS.js";
import { notificationMetrics, logDelivery } from "./notificationMetrics.js";

/**
 * Provider adapters. The live, general-purpose channels are socket + push (FCM).
 * SMS is used ONLY for OTP (see `smsAdapter`, invoked solely by the OTP event).
 * WhatsApp/email adapters are present for future use but intentionally NOT
 * wired into general dispatch yet (per deployment constraint).
 */

export const socketAdapter = async ({ recipientId, recipientType, socketEvent, data }) => {
  const start = Date.now();
  try {
    const io = getIo();
    if (!io) {
      notificationMetrics.increment("socket_emitted", 0);
      return { ok: false, permanent: false, error: "no_socket_io" };
    }
    const room =
      recipientType === "technician"
        ? SOCKET_ROOMS.TECHNICIAN(recipientId)
        : recipientType === "admin"
        ? SOCKET_ROOMS.ADMIN_DASHBOARD
        : SOCKET_ROOMS.CUSTOMER(recipientId);
    io.to(room).emit(socketEvent || "notification", data || {});
    notificationMetrics.increment("socket_emitted");
    logDelivery("socket", { ok: true }, { recipientId, recipientType }, Date.now() - start);
    return { ok: true };
  } catch (e) {
    logDelivery("socket", { ok: false, permanent: false, error: e.message }, { recipientId, recipientType }, Date.now() - start);
    return { ok: false, permanent: false, error: e.message };
  }
};

export const pushAdapter = async ({ recipientId, recipientType, title, body, data }) => {
  const start = Date.now();
  try {
    const result = await sendPushNotification(
      recipientId,
      { title, body, data: data || {} },
      { recipientType }
    );
    if (result && result.success === false && result.error) {
      const permanent = /not-registered|invalid-argument|unregistered|invalid/i.test(String(result.error));
      notificationMetrics.increment("push_sent", 0);
      logDelivery("push", { ok: false, permanent, error: result.error }, { recipientId, recipientType }, Date.now() - start);
      return { ok: false, permanent, error: result.error };
    }
    if (result?.skipped) {
      notificationMetrics.increment("push_skipped");
    } else {
      notificationMetrics.increment("push_sent");
    }
    logDelivery("push", { ok: true, providerMessageId: result?.success ? "fcm_multicast" : undefined }, { recipientId, recipientType }, Date.now() - start);
    return { ok: true, providerMessageId: result?.success ? "fcm_multicast" : undefined };
  } catch (e) {
    logDelivery("push", { ok: false, permanent: false, error: e.message }, { recipientId, recipientType }, Date.now() - start);
    return { ok: false, permanent: false, error: e.message };
  }
};

// OTP-only SMS path (kept separate from general notification dispatch).
export const smsAdapter = async ({ phoneNumber, message }) => {
  const start = Date.now();
  try {
    await sendSms(phoneNumber, message);
    notificationMetrics.increment("sms_sent");
    logDelivery("sms", { ok: true }, { phoneNumber }, Date.now() - start);
    return { ok: true };
  } catch (e) {
    const permanent = /invalid|dlr|blocked|permission/i.test(String(e.message));
    logDelivery("sms", { ok: false, permanent, error: e.message }, { phoneNumber }, Date.now() - start);
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
  notificationMetrics.increment("delivery_attempted");
  const start = Date.now();
  const result = (async () => {
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
        notificationMetrics.increment("channel_unknown");
        return { ok: false, permanent: true, error: `unknown_channel:${channel}` };
    }
  })();

  // Record latency after the promise resolves
  result.then((r) => {
    notificationMetrics.recordLatency("delivery_dispatch", Date.now() - start);
    if (r.ok) {
      notificationMetrics.increment("delivery_success");
    } else if (r.permanent) {
      notificationMetrics.increment("delivery_failed_permanent");
    } else {
      notificationMetrics.increment("delivery_failed_transient");
    }
  }).catch(() => {
    notificationMetrics.increment("delivery_failed_transient");
  });

  return result;
};
