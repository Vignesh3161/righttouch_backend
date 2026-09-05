import Notification from "../Schemas/Notification.js";
import NotificationDelivery from "../Schemas/NotificationDelivery.js";
import NotificationOutbox from "../Schemas/NotificationOutbox.js";
import { CHANNEL_POLICY, MAX_OUTBOX_ATTEMPTS } from "../Services/notificationService.js";
import { dispatchByChannel } from "./notificationAdapters.js";

const TERMINAL = new Set(["provider_accepted", "device_received", "opened", "failed", "skipped", "dead_letter"]);
const OUTBOX_BACKOFF_MS = 30000;
// 🔒 Lease TTL — a row flipped to "published" (leased) but not advanced to a
// terminal state within this window is assumed to have died with its worker and
// is reclaimed so the notification is not silently lost.
const LEASE_TTL_MS = 2 * 60 * 1000;

const buildPayload = (channel, notif) => {
  if (channel === "socket") {
    return {
      recipientId: notif.recipientId,
      recipientType: notif.recipientType,
      socketEvent: notif.data?.socketEvent,
      data: notif.data || {},
    };
  }
  if (channel === "push") {
    return {
      recipientId: notif.recipientId,
      recipientType: notif.recipientType,
      title: notif.title,
      body: notif.body,
      data: { type: notif.eventType, ...(notif.data || {}) },
    };
  }
  if (channel === "sms") {
    return { phoneNumber: notif.data?.phoneNumber, message: notif.data?.smsMessage || notif.body };
  }
  return { ...notif.data };
};

const processOutboxRecord = async (ob) => {
  const notif = await Notification.findById(ob.notificationId);
  if (!notif) {
    await NotificationOutbox.updateOne({ _id: ob._id }, { status: "failed", lastError: "notification_missing" });
    return;
  }

  const deliveries = await NotificationDelivery.find({
    notificationId: notif._id,
    status: { $in: ["pending", "queued"] },
  });

  let notTerminal = false;

  for (const d of deliveries) {
    const policy = CHANNEL_POLICY[d.channel] || { attempts: 1, backoffMs: 0 };

    if (d.attemptCount >= policy.attempts) {
      d.status = "dead_letter";
      d.failureCode = "MAX_ATTEMPTS";
      d.failureReason = "Exceeded retry attempts";
      await d.save();
      continue;
    }

    const res = await dispatchByChannel(d.channel, buildPayload(d.channel, notif)).catch((e) => ({
      ok: false,
      permanent: false,
      error: e.message,
    }));

    d.attemptCount += 1;
    d.lastAttemptAt = new Date();

    if (res.ok) {
      d.status = "provider_accepted";
      d.providerAcceptedAt = new Date();
      if (res.providerMessageId) d.providerMessageId = res.providerMessageId;
      if (res.providerResponse) d.providerResponse = res.providerResponse;
    } else if (res.permanent) {
      d.status = "failed";
      d.failureCode = "PERMANENT";
      d.failureReason = res.error || "permanent failure";
      d.failedAt = new Date();
    } else {
      d.status = "pending";
      d.nextAttemptAt = new Date(Date.now() + (policy.backoffMs || 5000));
      d.failureReason = res.error || "transient failure";
      notTerminal = true;
    }
    await d.save();
  }

  if (notTerminal) {
    const attempts = (ob.attempts || 0) + 1;
    if (attempts > MAX_OUTBOX_ATTEMPTS) {
      await NotificationOutbox.updateOne(
        { _id: ob._id },
        { status: "failed", lastError: "max_outbox_attempts", attempts }
      );
    } else {
      await NotificationOutbox.updateOne(
        { _id: ob._id },
        { status: "pending", nextAttemptAt: new Date(Date.now() + OUTBOX_BACKOFF_MS), attempts }
      );
    }
  } else {
    await NotificationOutbox.updateOne(
      { _id: ob._id },
      { status: "completed", completedAt: new Date() }
    );
  }
};

const tick = async () => {
  try {
    const now = new Date();
    const leaseCutoff = new Date(now.getTime() - LEASE_TTL_MS);
    const due = await NotificationOutbox.find({
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        // Reclaim rows leased long ago that never reached a terminal state
        // (worker crashed mid-processing). Reset the lease and retry.
        { status: "published", publishedAt: { $lte: leaseCutoff } },
      ],
    })
      .limit(50)
      .lean();
    for (const ob of due) {
      // Lease / reclaim: a freshly-due pending row is claimed; a stuck
      // published row has its lease refreshed so it can be processed again.
      const leased = await NotificationOutbox.findOneAndUpdate(
        { _id: ob._id, status: ob.status },
        { status: "published", publishedAt: new Date() },
        { new: true }
      );
      if (!leased) continue;
      await processOutboxRecord(leased);
    }
  } catch (e) {
    console.error("[notificationWorker] tick error:", e.message);
  }
};

let timer = null;
export const startNotificationWorker = (intervalMs = 5000) => {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`🔔 Notification worker started (every ${intervalMs}ms)`);
};
