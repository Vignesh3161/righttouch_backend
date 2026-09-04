import mongoose from "mongoose";
import Notification from "../Schemas/Notification.js";
import NotificationDelivery from "../Schemas/NotificationDelivery.js";
import NotificationOutbox from "../Schemas/NotificationOutbox.js";
import NotificationPreference from "../Schemas/NotificationPreference.js";
import { getEventPolicy, isValidEventType } from "../config/notificationEvents.js";
import { renderTemplate } from "../Utils/notificationTemplates.js";
import { hasNotificationPushAllowed } from "../Utils/permissionService.js";

// Channels actually wired in this deployment. WhatsApp/email reserved.
const ENABLED_CHANNELS = new Set(["socket", "push", "sms"]);

export const CHANNEL_POLICY = {
  socket: { attempts: 1, backoffMs: 0 },
  push: { attempts: 4, backoffMs: 5000 },
  sms: { attempts: 3, backoffMs: 10000 },
  whatsapp: { attempts: 3, backoffMs: 10000 },
  email: { attempts: 4, backoffMs: 10000 },
};

const MAX_OUTBOX_ATTEMPTS = 8;

const buildIdempotencyKey = (eventType, recipientType, recipientId, source) =>
  `${eventType}:${recipientType}:${recipientId}:${source?.id || ""}`;

const isWithinDnd = (pref, now = new Date()) => {
  try {
    if (!pref?.dnd?.enabled) return false;
    const [sh, sm] = String(pref.dnd.start || "22:00").split(":").map(Number);
    const [eh, em] = String(pref.dnd.end || "08:00").split(":").map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    if (s === e) return false;
    if (s > e) return cur >= s || cur < e; // wraps midnight
    return cur >= s && cur < e;
  } catch {
    return false;
  }
};

const dndEndDate = (pref, now = new Date()) => {
  const [eh, em] = String(pref.dnd.end || "08:00").split(":").map(Number);
  const end = new Date(now);
  end.setHours(eh, em, 0, 0);
  if (end <= now) end.setDate(end.getDate() + 1);
  return end;
};

/**
 * Central notify(). Persists before delivery, is idempotent, and respects
 * preferences + DND. Never throws — failures are logged, not propagated.
 */
export const notify = async (input = {}) => {
  const {
    eventType,
    recipientId,
    recipientType,
    data = {},
    source = {},
    correlationId,
    idempotencyKey,
    priorityOverride,
  } = input;

  try {
    if (!isValidEventType(eventType)) {
      console.warn(`[notify] unknown eventType ${eventType}`);
      return { success: false, reason: "unknown_event" };
    }
    if (!recipientId || !recipientType) {
      return { success: false, reason: "missing_recipient" };
    }

    const policy = getEventPolicy(eventType);
    const key = idempotencyKey || buildIdempotencyKey(eventType, recipientType, recipientId, source);

    const existing = await Notification.findOne({ idempotencyKey: key }).lean();
    if (existing) {
      return { success: true, idempotencyHit: true, notificationId: existing._id };
    }

    const pref = await NotificationPreference.findOne({ userId: recipientId }).lean().catch(() => null);
    const language = pref?.language || "en";

    const rendered = renderTemplate(eventType, language, data);
    const title = rendered?.title || data.title || eventType;
    const body = rendered?.body || data.body || "";

    // Channel selection
    let channels = (policy.defaultChannels || []).filter((c) => ENABLED_CHANNELS.has(c));
    if (eventType !== "OTP") {
      channels = channels.filter((c) => {
        if (c === "push") return pref ? pref.channels?.push !== false : true;
        return true; // socket always allowed
      });
    }

    // 🔐 MOBILE PERMISSION GATE (section 20): withhold push when the recipient
    // has reported notification permission as denied/restricted. The
    // Notification + Outbox records are STILL created (visibility that the
    // event was generated), only the push channel is dropped — socket delivery
    // and the audit trail remain. We never assume a valid FCM token implies
    // permission to use it.
    if (channels.includes("push")) {
      const pushAllowed = await hasNotificationPushAllowed({
        userId: recipientId,
        role: recipientType,
      }).catch(() => true);
      if (!pushAllowed) {
        console.log(
          `[notify] push withheld for ${recipientType} ${recipientId}: notification permission not granted`
        );
        channels = channels.filter((c) => c !== "push");
      }
    }
    if (!channels.length) channels = ["socket"];

    // DND: delay dispatch for delayable events
    let outboxNext = new Date();
    if (policy.dndAllowed && isWithinDnd(pref)) {
      outboxNext = dndEndDate(pref);
    }

    const notification = await Notification.create({
      recipientId,
      recipientType,
      eventType,
      title,
      body,
      data: { ...data, socketEvent: policy.socketEvent },
      priority: priorityOverride || policy.priority || "normal",
      category: policy.category || "general",
      sourceType: source?.type,
      sourceId: source?.id,
      correlationId,
      idempotencyKey: key,
    });

    const deliveryDocs = channels.map((channel) => ({
      notificationId: notification._id,
      recipientId,
      channel,
      status: "pending",
      nextAttemptAt: new Date(),
    }));
    await NotificationDelivery.insertMany(deliveryDocs);

    await NotificationOutbox.create({
      notificationId: notification._id,
      eventType,
      sourceType: source?.type,
      sourceId: source?.id,
      status: "pending",
      nextAttemptAt: outboxNext,
    });

    return { success: true, notificationId: notification._id, channels };
  } catch (e) {
    console.error("[notify] error:", e.message);
    return { success: false, reason: e.message };
  }
};

export { MAX_OUTBOX_ATTEMPTS };
