import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianSlot from "../Schemas/TechnicianSlot.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import {
  releaseScheduledSlot,
  releaseTechnicianSlot,
} from "./slotCapacityService.js";
import { emitJobsChanged } from "../Utils/sendNotification.js";

/**
 * Returns the technician's active scheduled slot that overlaps `at`, if any.
 * Used to hide instant offers while a scheduled slot is committed.
 */
export const getBlockingTechnicianSlot = async (technicianId, at = new Date()) => {
  return TechnicianSlot.findOne({
    technicianId,
    active: true,
    slotStartAt: { $lte: at },
    slotEndAt: { $gt: at },
  })
    .sort({ slotStartAt: 1 })
    .lean();
};

export const getBlockedTechnicianIds = async (technicianIds = [], at = new Date()) => {
  if (!technicianIds.length) return new Set();
  const rows = await TechnicianSlot.find({
    technicianId: { $in: technicianIds },
    active: true,
    slotStartAt: { $lte: at },
    slotEndAt: { $gt: at },
  })
    .select("technicianId")
    .lean();
  return new Set(rows.map((row) => String(row.technicianId)));
};

export const isTechnicianBlockedForInstant = async (technicianId, at = new Date()) => {
  const slot = await getBlockingTechnicianSlot(technicianId, at);
  return Boolean(slot);
};

/**
 * Release every future scheduled slot for a technician and put the affected
 * bookings back into dispatch. Called on hard ineligibility events only
 * (suspend/deactivate/delete, KYC/bank rejection, workStatus leaving approved).
 */
export const releaseFutureScheduledSlotsForTechnician = async ({
  technicianId,
  reason,
  actor = "system",
  io = null,
  now = new Date(),
}) => {
  if (!technicianId) return { released: 0, bookingIds: [] };
  const slots = await TechnicianSlot.find({
    technicianId,
    active: true,
    slotEndAt: { $gte: now },
  }).lean();

  const bookingIds = [];
  for (const slot of slots) {
    const booking = await ServiceBooking.findById(slot.bookingId);
    if (!booking) {
      await releaseTechnicianSlot({
        technicianId,
        slotKey: slot.slotKey,
        bookingId: slot.bookingId,
        reason,
      });
      continue;
    }

    // Platform-initiated release: no penalty/strike.
    booking.technicianId = null;
    booking.assignmentStatus = "unassigned";
    booking.status = "pending";
    booking.activeBroadcastVersion = 0;
    booking.dispatchEligibleAt = now;
    booking.broadcastStartedAt = null;
    booking.assignedAt = null;
    booking.customerStatusLabel = "Awaiting technician";
    booking.assignmentAttempts.push({
      technicianId,
      attemptNumber: (booking.assignmentAttempts?.length || 0) + 1,
      status: "released",
      releasedAt: now,
      releaseReason: `hard_ineligible:${reason}`,
    });
    await booking.save();

    await releaseScheduledSlot({
      bookingId: booking._id,
      reason: `hard_ineligible:${reason}`,
      expired: false,
    });
    bookingIds.push(String(booking._id));

    try {
      emitJobsChanged(io, technicianId, {
        action: "released",
        bookingId: booking._id,
        reasons: [reason],
      });
    } catch {
      // notification failures must not block release
    }
  }

  if (bookingIds.length) {
    const { matchAndBroadcastBooking } = await import("../Utils/technicianMatching.js");
    for (const bookingId of bookingIds) {
      try {
        await matchAndBroadcastBooking(bookingId, io);
      } catch (error) {
        console.warn(
          `[TechnicianSlot] re-dispatch failed for ${bookingId}: ${error.message}`
        );
      }
    }
  }

  console.log(
    `[TechnicianSlot] hard ineligibility release tech=${technicianId} reason=${reason} actor=${actor} bookings=${bookingIds.length}`
  );
  return { released: bookingIds.length, bookingIds };
};

/**
 * Soft offline (app closed) must NOT release scheduled slots. This helper only
 * records the reason; the watchdog may nudge the technician near slot start.
 */
export const noteTechnicianSoftOffline = async ({ technicianId, offlineReason }) => {
  if (!technicianId) return null;
  return TechnicianProfile.updateOne(
    { _id: technicianId },
    { $set: { "availability.offlineReason": offlineReason || "offline" } }
  );
};

export const countScheduledJobsForDay = async ({ technicianId, dayStart, dayEnd }) => {
  return TechnicianSlot.countDocuments({
    technicianId,
    active: true,
    slotStartAt: { $gte: dayStart, $lt: dayEnd },
  });
};

export const markLateCompletionAtRisk = async ({ bookingId, technicianId, slotKey }) => {
  const now = new Date();
  await ServiceBooking.updateOne(
    { _id: bookingId },
    {
      $set: {
        lateCompletionAtRisk: true,
        lateCompletionDetectedAt: now,
        originalTechnicianId: technicianId || null,
      },
    }
  );
  if (technicianId && slotKey) {
    await TechnicianSlot.updateOne(
      { technicianId, slotKey, active: true },
      { $set: { lateCompletionAtRisk: true } }
    );
  }
  return now;
};

export const clearLateCompletionRisk = async (bookingId) => {
  await ServiceBooking.updateOne(
    { _id: bookingId },
    { $set: { lateCompletionAtRisk: false } }
  );
};

export const objectId = (value) =>
  mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
