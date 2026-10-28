/**
 * 📤 BOOKING OUTBOX WORKER — consumes booking-level events.
 *
 * Booking transactions insert a BOOKING_CREATED row in the same commit.
 * This worker claims rows and broadcasts to technicians — guaranteeing the
 * broadcast can never happen before the booking commits, with retry on
 * failure. Same claim-poll pattern as the dispatch queue.
 */

import BookingOutbox from "../Schemas/BookingOutbox.js";
import { processBookingCreatedOutbox } from "./bookingService.js";
import { matchAndBroadcastBooking } from "./technicianMatching.js";
import { recordBookingOutbox } from "./broadcastMetrics.js";
import mongoose from "mongoose";

const POLL_INTERVAL_MS = 1500;
const BATCH_SIZE = 10;
const CONCURRENCY = 3;
const CLAIM_TTL_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;
const BACKOFF_BASE_MS = 1000;

let ioRef = null;
let pollTimer = null;
let stopped = false;
let started = false;
let running = 0;
let polling = false;

const backoffFor = (attempts) => {
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** attempts, MAX_BACKOFF_MS);
  return Math.max(250, Math.floor(Math.random() * ceiling));
};

// Claim fencing: a stale worker must not overwrite a row that was reclaimed
// or otherwise re-claimed after its own claim expired.
const claimUpdateFilter = (row) => ({
  _id: row._id,
  ...(row.claimedAt ? { status: "inflight", claimedAt: row.claimedAt } : {}),
});

const updateClaimedRow = (row, update) =>
  BookingOutbox.updateOne(claimUpdateFilter(row), update);

const claimOne = async () => {
  const now = new Date();
  const row = await BookingOutbox.findOneAndUpdate(
    { status: "pending", nextAttemptAt: { $lte: now } },
    { $set: { status: "inflight", claimedAt: now } },
    { new: true, sort: { createdAt: 1 } }
  );
  if (row) return row;
  // Stale claim recovery: keep the row inflight and atomically take ownership.
  return BookingOutbox.findOneAndUpdate(
    {
      status: "inflight",
      claimedAt: { $lte: new Date(Date.now() - CLAIM_TTL_MS) },
    },
    {
      $set: { claimedAt: now, lastError: "reclaimed_after_claim_ttl" },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { claimedAt: 1 } }
  );
};

const markDone = (row, lastError = null) =>
  updateClaimedRow(row, {
    $set: { status: "done", completedAt: new Date(), lastError },
  });

const scheduleRetry = async (row, err) => {
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
  recordBookingOutbox(giveUp ? "failed" : "retried");
  console.warn(`[BookingOutbox] ${giveUp ? "FAILED" : "retry"} ${row.eventType} booking=${row.aggregateId} (attempt ${attempts}): ${err.message}`);
};

/** Exported for regression tests; production entry remains the poller. */
export const processRow = async (row) => {
  try {
    const verdict = await processBookingCreatedOutbox(row);

    if (verdict.status === "done") {
      await markDone(row, verdict.reason || "skipped");
      recordBookingOutbox("done");
      return;
    }

    if (verdict.status !== "run") {
      throw new Error(`unexpected verdict ${verdict.status}`);
    }

    const traceId = verdict.traceId;
    console.log(`[TRACE] ${traceId} OUTBOX_WORKER_BROADCAST bookingId=${row.aggregateId}`);
    const result = await matchAndBroadcastBooking(row.aggregateId, ioRef, traceId);

    if (result?.success) {
      if (result.outcome === "MATCH_IN_PROGRESS") {
        // Another worker holds the matching lease. This is transient, not a
        // match failure: retry the outbox row with backoff.
        await scheduleRetry(row, new Error("MATCH_IN_PROGRESS"));
        return;
      }
      if (result.outcome === "BROADCASTED") {
        await markDone(row, null);
        recordBookingOutbox("done");
        return;
      }
      // Screened-out or terminal business outcomes are recorded once and
      // never retried. Operators can see the exact stage/reason.
      const reason = [result.outcome, result.stage, result.reason]
        .filter(Boolean)
        .join(":") || "no_match";
      await markDone(row, reason);
      recordBookingOutbox(
        result.outcome === "NO_ELIGIBLE_TECHNICIANS" ? "no_candidates" : "done"
      );
      console.log(`[BookingOutbox] DONE_WITHOUT_BROADCAST booking=${row.aggregateId} outcome=${reason} reasons=${JSON.stringify(result.reasonTally || {})}`);
      return;
    }

    if (result?.retryable === false) {
      await updateClaimedRow(row, {
        $set: {
          status: "failed",
          attempts: (row.attempts || 0) + 1,
          completedAt: new Date(),
          lastError: (result.outcome || result.error || "non_retryable").slice(0, 500),
        },
      });
      recordBookingOutbox("failed");
      console.warn(`[BookingOutbox] PERMANENT FAILURE booking=${row.aggregateId} outcome=${result.outcome || result.error}`);
      return;
    }

    throw new Error(result?.error || result?.outcome || "broadcast_failed");
  } catch (err) {
    await scheduleRetry(row, err);
  }
};

const poll = async () => {
  if (stopped || polling || running >= CONCURRENCY) return;
  // 🔌 Don't touch Mongo while disconnected — avoids 10s buffer timeouts.
  if (mongoose.connection.readyState !== 1) {
    if (!stopped) pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    return;
  }
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
    if (batch.length) {
      running += batch.length;
      try {
        await Promise.allSettled(batch.map(processRow));
      } finally {
        running -= batch.length;
      }
    }
  } catch (err) {
    console.error("[BookingOutbox] poll error:", err.message);
  } finally {
    polling = false;
    if (!stopped) {
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  }
};

export const startBookingOutboxWorker = (io) => {
  ioRef = io;
  if (started) return;
  started = true;
  stopped = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  console.log("[BookingOutbox] worker started");
};

export const stopBookingOutboxWorker = () => {
  stopped = true;
  started = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
};