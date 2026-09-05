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
import { notifyTechnicianOfNewJob } from "./sendNotification.js";
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
let running = 0;
let polling = false; // single-flight guard — prevents overlapping poll cycles
let drainScheduled = false;

const backoffFor = (attempts) =>
  Math.min(BACKOFF_BASE_MS * 2 ** attempts, MAX_BACKOFF_MS);

/** Claim one row atomically: pending → inflight. Returns doc or null. */
const claimOne = async () => {
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
  // Reclaim rows orphaned by a crashed worker mid-delivery
  return DispatchOutbox.findOneAndUpdate(
    {
      status: "inflight",
      claimedAt: { $lte: new Date(Date.now() - CLAIM_TTL_MS) },
    },
    { $set: { status: "pending", nextAttemptAt: now } },
    { new: false, sort: { claimedAt: 1 } }
  );
};

const processRow = async (row) => {
  const { bookingId, technicianId, kind, broadcastId, version, payload } = row;
  try {
    // 🛡 Pre-send booking status check: if booking was cancelled, accepted, or expired
    // while this outbox row was pending/inflight, skip notification entirely.
    if (bookingId) {
      const booking = await ServiceBooking.findById(bookingId).select("status").lean();
      if (booking && !["pending", "broadcasted"].includes(booking.status)) {
        await DispatchOutbox.updateOne(
          { _id: row._id },
          { $set: { status: "done", completedAt: new Date(), lastError: `booking_${booking.status}` } }
        );
        return;
      }
    }

    const broadcast = broadcastId
      ? { _id: broadcastId, version: version ?? 1 }
      : null;
    const result = await notifyTechnicianOfNewJob(ioRef, technicianId.toString(), payload, broadcast);

    if (result?.skipped) {
      // Duplicate or ineligible — nothing to deliver, don't burn retries.
      await DispatchOutbox.updateOne(
        { _id: row._id },
        { $set: { status: "done", completedAt: new Date(), lastError: result.reason || "skipped" } }
      );
      return;
    }
    if (result?.success) {
      await DispatchOutbox.updateOne(
        { _id: row._id },
        { $set: { status: "done", completedAt: new Date() } }
      );
      return;
    }
    throw new Error(result?.error || `notify failed (kind=${kind})`);
  } catch (err) {
    const attempts = (row.attempts || 0) + 1;
    const giveUp = attempts >= (row.maxAttempts || 6);
    await DispatchOutbox.updateOne(
      { _id: row._id },
      giveUp
        ? { $set: { status: "failed", attempts, lastError: err.message?.slice(0, 500) } }
        : {
            $set: {
              status: "pending",
              attempts,
              lastError: err.message?.slice(0, 500),
              nextAttemptAt: new Date(Date.now() + backoffFor(attempts)),
            },
          }
    );
    console.warn(`[DispatchQueue] ${giveUp ? "FAILED" : "retry"} booking=${bookingId} tech=${technicianId} (attempt ${attempts}): ${err.message}`);
  }
};

/** One poll cycle: claim up to BATCH_SIZE rows, process with CONCURRENCY cap. */
const poll = async () => {
  // 🔌 Single-flight + concurrency guard: only one poll cycle runs at a time,
  // so `running` can't be oversubscribed by overlapping setInterval /
  // setImmediate(drain) invocations (concurrent-broadcast hardening).
  if (stopped || polling || running >= CONCURRENCY) return;
  // 🔌 Don't touch Mongo while disconnected — avoids 10s buffer timeouts.
  if (mongoose.connection.readyState !== 1) return;
  polling = true;
  try {
    const batch = [];
    while (batch.length < BATCH_SIZE && running < CONCURRENCY) {
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

export const enqueueJobNewNotifications = async ({ bookingId, technicianIds, jobData, broadcastMap }) => {
  if (!technicianIds?.length) return { count: 0 };
  const rows = technicianIds.map((techId) => {
    const idStr = String(techId);
    const broadcast = broadcastMap?.get(idStr);
    return {
      bookingId,
      technicianId: idStr,
      kind: "job_new",
      broadcastId: broadcast?._id || null,
      version: broadcast?.version || 1,
      payload: jobData,
      status: "pending",
      nextAttemptAt: new Date(),
    };
  });

  try {
    await DispatchOutbox.insertMany(rows, { ordered: false, lean: true });
  } catch (err) {
    // E11000 collisions (re-broadcast already queued) are fine — skip.
    if (err?.code !== 11000) {
      console.error("[DispatchQueue] enqueue error:", err.message);
      return { count: 0, error: err.message };
    }
  }

  // Kick a drain immediately so latency stays ~0 (not 1.5s poll)
  if (!drainScheduled) {
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      poll().catch(() => {});
    });
  }
  return { count: rows.length };
};

export const startDispatchWorker = (io) => {
  if (pollTimer) return;
  ioRef = io;
  stopped = false;
  pollTimer = setInterval(() => poll().catch(() => {}), POLL_INTERVAL_MS);
  pollTimer.unref?.();
  console.log("🚚 Dispatch queue worker active (bounded concurrency, at-least-once delivery).");
};

export const stopDispatchWorker = () => {
  stopped = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};
