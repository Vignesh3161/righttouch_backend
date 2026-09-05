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
import mongoose from "mongoose";

const POLL_INTERVAL_MS = 1500;
const CLAIM_TTL_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;
const BACKOFF_BASE_MS = 1000;

let ioRef = null;
let pollTimer = null;
let stopped = false;
let running = 0;

const backoffFor = (attempts) =>
  Math.min(BACKOFF_BASE_MS * 2 ** attempts, MAX_BACKOFF_MS);

const claimOne = async () => {
  const now = new Date();
  const row = await BookingOutbox.findOneAndUpdate(
    { status: "pending", nextAttemptAt: { $lte: now } },
    { $set: { status: "inflight", claimedAt: now } },
    { new: true, sort: { createdAt: 1 } }
  );
  if (row) return row;
  return BookingOutbox.findOneAndUpdate(
    {
      status: "inflight",
      claimedAt: { $lte: new Date(Date.now() - CLAIM_TTL_MS) },
    },
    { $set: { status: "pending", nextAttemptAt: now } },
    { new: false, sort: { claimedAt: 1 } }
  );
};

const processRow = async (row) => {
  try {
    const verdict = await processBookingCreatedOutbox(row);

    if (verdict.status === "done") {
      await BookingOutbox.updateOne(
        { _id: row._id },
        { $set: { status: "done", completedAt: new Date(), lastError: verdict.reason || "skipped" } }
      );
      return;
    }

    if (verdict.status === "run") {
      await matchAndBroadcastBooking(row.aggregateId, ioRef);
      await BookingOutbox.updateOne(
        { _id: row._id },
        { $set: { status: "done", completedAt: new Date() } }
      );
      return;
    }

    throw new Error(`unexpected verdict ${verdict.status}`);
  } catch (err) {
    const attempts = (row.attempts || 0) + 1;
    const giveUp = attempts >= (row.maxAttempts || 6);
    await BookingOutbox.updateOne(
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
    console.warn(`[BookingOutbox] ${giveUp ? "FAILED" : "retry"} ${row.eventType} booking=${row.aggregateId} (attempt ${attempts}): ${err.message}`);
  }
};

const poll = async () => {
  if (stopped) return;
  if (running >= 3) return;
  // 🔌 Don't touch Mongo while disconnected — avoids 10s buffer timeouts.
  if (mongoose.connection.readyState !== 1) return;
  try {
    const row = await claimOne();
    if (row) {
      running += 1;
      try {
        await processRow(row);
      } finally {
        running -= 1;
      }
    }
  } catch (err) {
    console.error("[BookingOutbox] poll error:", err.message);
  } finally {
    if (!stopped) {
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  }
};

export const startBookingOutboxWorker = (io) => {
  ioRef = io;
  stopped = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  console.log("[BookingOutbox] worker started");
};

export const stopBookingOutboxWorker = () => {
  stopped = true;
  if (pollTimer) clearTimeout(pollTimer);
};