/**
 * 🚚 DISPATCH QUEUE — bounded-concurrency worker over the DispatchOutbox.
 *
 * The matching engine's job is to DECIDE who gets notified, not to DO the
 * notifying inline. Broadcast fan-out (N push+socket sends per job) moves
 * here:
 *
 *   MatchingService computes candidates → enqueueJobNewNotifications()
 *   Worker (bounded concurrency, retries + backoff) delivers independently.
 *
 * No external queue infra — Mongo outbox + a claim-poll, same pattern as the
 * payout reconciliation cron. Safe across restarts (inflight claims expire).
 */

import DispatchOutbox from "../Schemas/DispatchOutbox.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import { normalizeBookingStatus } from "./bookingStatus.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import { notifyTechnicianOfNewJob } from "./sendNotification.js";
import { recordDispatch } from "./broadcastMetrics.js";
import mongoose from "mongoose";

const POLL_INTERVAL_MS = 1500;
const BATCH_SIZE = 50;
const CONCURRENCY = 10;
const CLAIM_TTL_MS = 2 * 60 * 1000; // crash recovery: reclaim stale inflight rows
const MAX_BACKOFF_MS = 60 * 1000;
const BACKOFF_BASE_MS = 1000;

let ioRef = null;
let pollTimer = null;
let stopped = false;
let started = false;
let running = 0;
let polling = false; // single-flight guard — prevents overlapping poll cycles
let drainScheduled = false;

const backoffFor = (attempts) => {
  // Exponential backoff with full jitter avoids retry storms when a push
  // provider/proxy is briefly unavailable.
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** attempts, MAX_BACKOFF_MS);
  return Math.max(250, Math.floor(Math.random() * ceiling));
};

// Claim fencing: a stale worker must not overwrite a row that was reclaimed,
// re-enqueued for a new broadcast, or manually retried after its claim.
const claimUpdateFilter = (row) => ({
  _id: row._id,
  ...(row.claimedAt ? { status: "inflight", claimedAt: row.claimedAt } : {}),
});

const updateClaimedRow = (row, update) =>
  DispatchOutbox.updateOne(claimUpdateFilter(row), update);

/** Claim one row atomically: pending → inflight. Returns doc or null. */
export const claimOne = async () => {
  const now = new Date();
  const row = await DispatchOutbox.findOneAndUpdate(
    {
      status: "pending",
      nextAttemptAt: { $lte: now },
    },
    { $set: { status: "inflight", claimedAt: now } },
    { new: true, sort: { createdAt: 1 } }
  );
  if (row) return row;
  // Reclaim rows orphaned by a crashed worker mid-delivery. Keep status
  // inflight while refreshing claimedAt so no second worker can claim in the
  // gap between reset-to-pending and re-claim.
  return DispatchOutbox.findOneAndUpdate(
    {
      status: "inflight",
      claimedAt: { $lte: new Date(Date.now() - CLAIM_TTL_MS) },
    },
    { $set: { claimedAt: now, lastError: "reclaimed_after_claim_ttl" } },
    { new: true, sort: { claimedAt: 1 } }
  );
};

/** Exported for regression tests (H25). Production entry remains the poller. */
export const processRow = async (row) => {
  const { bookingId, technicianId, kind, broadcastId, version, payload } = row;
  const traceId = payload?.traceId || `trc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    // 🛡 Pre-send booking status check: if booking was cancelled, accepted, or expired
    // while this outbox row was pending/inflight, skip notification entirely.
    if (bookingId) {
      const booking = await ServiceBooking.findById(bookingId).select("status").lean();
      if (!booking) {
        await updateClaimedRow(row, {
          $set: { status: "done", completedAt: new Date(), lastError: "booking_missing" },
        });
        console.log(`📭 [TRACE] ${traceId} DISPATCH_SKIPPED bookingId=${bookingId} tech=${technicianId} reason=booking_missing`);
        return;
      }
      const bookingStatus = normalizeBookingStatus(booking.status);
      if (!["pending", "broadcasted"].includes(bookingStatus)) {
        await updateClaimedRow(row, {
          $set: { status: "done", completedAt: new Date(), lastError: `booking_${bookingStatus}` },
        });
        console.log(`📭 [TRACE] ${traceId} DISPATCH_SKIPPED bookingId=${bookingId} tech=${technicianId} reason=booking_status_${bookingStatus}`);
        return;
      }
    }

    const broadcast = broadcastId
      ? { _id: broadcastId, version: version ?? 1 }
      : null;
    // H25: the offer itself must still be live (sent + version-current).
    // A broadcast expired, superseded, or accepted after enqueue must not
    // produce a valid-looking notification for an unavailable job — the
    // accept path would only 409. Stale rows complete as stale (no retry).
    if (broadcastId) {
      const live = await JobBroadcast.findById(broadcastId)
        .select("status version expiresAt")
        .lean();
      const stale =
        !live ||
        live.status !== "sent" ||
        (version != null && live.version !== version) ||
        (live.expiresAt && new Date(live.expiresAt).getTime() <= Date.now());
      if (stale) {
        await updateClaimedRow(row, {
          $set: { status: "done", completedAt: new Date(), lastError: "stale_broadcast" },
        });
        console.log(`📭 [TRACE] ${traceId} DISPATCH_SKIPPED bookingId=${bookingId} tech=${technicianId} reason=stale_broadcast`);
        return;
      }
    }
    const result = await notifyTechnicianOfNewJob(ioRef, technicianId.toString(), payload, broadcast);

    if (result?.skipped) {
      // Duplicate or ineligible — nothing to deliver, don't burn retries.
      await updateClaimedRow(row, {
        $set: { status: "done", completedAt: new Date(), lastError: result.reason || "skipped" },
      });
      recordDispatch("skipped");
      console.log(`📭 [TRACE] ${traceId} DISPATCH_SKIPPED bookingId=${bookingId} tech=${technicianId} reason=${result.reason}`);
      return;
    }
    if (result?.success) {
      await updateClaimedRow(row, {
        $set: { status: "done", completedAt: new Date(), lastError: null },
      });
      recordDispatch("done");
      console.log(`📬 [TRACE] ${traceId} DISPATCH_SUCCESS bookingId=${bookingId} tech=${technicianId} socket=${result.socket?.success} push=${result.push ? !result.push.skipped : "batched"} degraded=${result.degraded === true}`);
      return;
    }
    if (result?.retryable === false) {
      // Permanent business failure (e.g. all device tokens permanently
      // invalid). Retrying cannot help; surface it for operational review.
      await updateClaimedRow(row, {
        $set: {
          status: "failed",
          attempts: (row.attempts || 0) + 1,
          completedAt: new Date(),
          lastError: (result.error || "non_retryable").slice(0, 500),
        },
      });
      recordDispatch("failed");
      console.warn(`[DispatchQueue] PERMANENT FAILURE booking=${bookingId} tech=${technicianId}: ${result.error}`);
      return;
    }
    throw new Error(result?.error || `notify failed (kind=${kind})`);
  } catch (err) {
    const attempts = (row.attempts || 0) + 1;
    const giveUp = attempts >= (row.maxAttempts || 6);
    await updateClaimedRow(
      row,
      giveUp
        ? {
            $set: {
              status: "failed",
              attempts,
              completedAt: new Date(),
              lastError: err.message?.slice(0, 500),
            },
          }
        : {
            $set: {
              status: "pending",
              attempts,
              claimedAt: null,
              lastError: err.message?.slice(0, 500),
              nextAttemptAt: new Date(Date.now() + backoffFor(attempts)),
            },
          }
    );
    recordDispatch(giveUp ? "failed" : "retried");
    console.warn(`[DispatchQueue] ${giveUp ? "FAILED" : "retry"} booking=${bookingId} tech=${technicianId} (attempt ${attempts}): ${err.message}`);
  }
};

/** One poll cycle: claim up to BATCH_SIZE rows, process with CONCURRENCY cap. */
export const poll = async () => {
  // 🔌 Single-flight + concurrency guard: only one poll cycle runs at a time,
  // so `running` can't be oversubscribed by overlapping setInterval /
  // setImmediate(drain) invocations (concurrent-broadcast hardening).
  if (stopped || polling || running >= CONCURRENCY) return;
  // 🔌 Don't touch Mongo while disconnected — avoids 10s buffer timeouts.
  if (mongoose.connection.readyState !== 1) return;
  polling = true;
  try {
    const batch = [];
    while (
      batch.length < BATCH_SIZE &&
      running + batch.length < CONCURRENCY
    ) {
      const row = await claimOne();
      if (!row) break;
      batch.push(row);
    }
    if (batch.length > 0) {
      running += batch.length;
      await Promise.allSettled(batch.map(processRow));
      running -= batch.length;
    }
  } catch (err) {
    console.error("[DispatchQueue] poll error:", err.message);
  } finally {
    polling = false;
  }
};

export const buildDispatchOutboxOp = ({
  bookingId,
  technicianId,
  broadcastId = null,
  version = 1,
  kind = "job_new",
  payload = null,
}) => ({
  updateOne: {
    filter: {
      bookingId,
      technicianId,
      kind,
      status: { $in: ["pending", "inflight"] },
    },
    update: {
      $set: {
        broadcastId: broadcastId || null,
        version: version || 1,
        payload,
        status: "pending",
        nextAttemptAt: new Date(),
        attempts: 0,
        lastError: null,
        claimedAt: null,
        completedAt: null,
      },
      $setOnInsert: {
        bookingId,
        technicianId,
        kind,
      },
    },
    upsert: true,
  },
});

export const enqueueJobNewNotifications = async ({ bookingId, technicianIds, jobData, broadcastMap, traceId }) => {
  if (!technicianIds?.length) return { count: 0 };
  const trc = traceId || `trc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  // H25: idempotent enqueue via updateOne+upsert. A re-broadcast matches the
  // existing live row and refreshes its broadcast/version/payload so the
  // worker cannot deliver a stale offer or silently skip the new cycle.
  // The partial unique index remains the duplicate backstop.
  const ops = technicianIds.map((techId) => {
    const idStr = String(techId);
    const broadcast = broadcastMap?.get(idStr);
    return buildDispatchOutboxOp({
      bookingId,
      technicianId: idStr,
      broadcastId: broadcast?._id || null,
      version: broadcast?.version || 1,
      payload: { ...jobData, traceId: trc },
    });
  });

  try {
    await DispatchOutbox.bulkWrite(ops, { ordered: false });
  } catch (err) {
    // E11000 collisions (re-broadcast already queued) are fine — skip.
    if (err?.code !== 11000) {
      console.error("[DispatchQueue] enqueue error:", err.message);
      return { count: 0, error: err.message };
    }
  }

  // Kick a drain immediately so latency stays ~0 (not 1.5s poll)
  wakeDispatchWorker();
  return { count: technicianIds.length };
};

export const startDispatchWorker = (io) => {
  ioRef = io;
  if (pollTimer) return;
  stopped = false;
  started = true;
  pollTimer = setInterval(() => poll().catch(() => {}), POLL_INTERVAL_MS);
  pollTimer.unref?.();
  console.log("🚚 Dispatch queue worker active (bounded concurrency, at-least-once delivery).");
};

/**
 * Coalesced immediate drain. Safe to call after enqueueing rows so latency is
 * independent of the 1.5s poll interval. Exported for the admin retry route
 * and for matching (after the outbox transaction commits).
 */
export const wakeDispatchWorker = () => {
  if (stopped || !started) return;
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(() => {
    drainScheduled = false;
    poll().catch(() => {});
  });
};

export const stopDispatchWorker = () => {
  stopped = true;
  started = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};
