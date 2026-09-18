import Notification from "../Schemas/Notification.js";
import NotificationDelivery from "../Schemas/NotificationDelivery.js";
import NotificationOutbox from "../Schemas/NotificationOutbox.js";
import { CHANNEL_POLICY, MAX_OUTBOX_ATTEMPTS } from "../Services/notificationService.js";
import { dispatchByChannel } from "./notificationAdapters.js";
import { notificationMetrics, logOutbox, logDelivery } from "./notificationMetrics.js";

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
  const start = Date.now();
  const notif = await Notification.findById(ob.notificationId);
  if (!notif) {
    await NotificationOutbox.updateOne({ _id: ob._id }, { status: "failed", lastError: "notification_missing" });
    logOutbox("missing_notification", ob._id, { durationMs: Date.now() - start });
    notificationMetrics.increment("outbox_failed");
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
      notificationMetrics.increment("delivery_dead_letter");
      logOutbox("dead_letter", ob._id, { channel: d.channel, deliveryId: d._id });
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
      logDelivery(d.channel, res, { recipientId: notif.recipientId, recipientType: notif.recipientType }, Date.now() - start);
    } else if (res.permanent) {
      d.status = "failed";
      d.failureCode = "PERMANENT";
      d.failureReason = res.error || "permanent failure";
      d.failedAt = new Date();
      logDelivery(d.channel, res, { recipientId: notif.recipientId, recipientType: notif.recipientType }, Date.now() - start);
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
      logOutbox("max_attempts_failed", ob._id, { attempts, durationMs: Date.now() - start });
      notificationMetrics.increment("outbox_failed");
    } else {
      await NotificationOutbox.updateOne(
        { _id: ob._id },
        { status: "pending", nextAttemptAt: new Date(Date.now() + OUTBOX_BACKOFF_MS), attempts }
      );
      logOutbox("requeued", ob._id, { attempts, nextAttemptAt: new Date(Date.now() + OUTBOX_BACKOFF_MS), durationMs: Date.now() - start });
      notificationMetrics.increment("outbox_retried");
    }
  } else {
    await NotificationOutbox.updateOne(
      { _id: ob._id },
      { status: "completed", completedAt: new Date() }
    );
    logOutbox("completed", ob._id, { durationMs: Date.now() - start });
    notificationMetrics.increment("outbox_completed");
  }
  notificationMetrics.increment("outbox_processed");
  notificationMetrics.recordLatency("outbox_tick", Date.now() - start);
};

const tick = async () => {
  const start = Date.now();
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
  } finally {
    notificationMetrics.recordLatency("outbox_tick", Date.now() - start);
  }
};

let timer = null;
let metricsTimer = null;
export const startNotificationWorker = (intervalMs = 5000) => {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();

  // Periodic metrics logging (every 60s)
  metricsTimer = setInterval(() => {
    const summary = notificationMetrics.getSummary();
    console.log("📊 [NOTIFICATION METRICS]", JSON.stringify(summary, null, 2));
  }, 60000);
  if (metricsTimer.unref) metricsTimer.unref();

  console.log(`🔔 Notification worker started (every ${intervalMs}ms)`);
};

export const stopNotificationWorker = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
};
