import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianSlot from "../Schemas/TechnicianSlot.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import { findEligibleTechniciansForService } from "../Utils/technicianMatching.js";
import { notifyTechnicianWithFallback, emitJobsChanged } from "../Utils/sendNotification.js";
import { auditPurgeAt } from "../Utils/broadcastRetention.js";
import { REPLACEMENT_SEARCH_MINUTES, MAX_SCHEDULED_JOBS_PER_DAY_DEFAULT } from "../Utils/schedulingConfig.js";
import { startOfBusinessDayUtc } from "../Utils/slots.js";
import { markLateCompletionAtRisk } from "./technicianSlotService.js";
import { findNextActiveSlotForTechnician } from "./slotCapacityService.js";

const DEFAULT_DURATION_MINUTES = 60;
const TRAVEL_BUFFER_MINUTES = 30;

export const projectedReadyAt = (booking, now = new Date()) => {
  const startedAt = booking.inProgressAt || booking.reachedAt || booking.onTheWayAt || now;
  const duration = Number(booking.estimatedDurationMinutes) || DEFAULT_DURATION_MINUTES;
  return new Date(new Date(startedAt).getTime() + (duration + TRAVEL_BUFFER_MINUTES) * 60 * 1000);
};

export const isLateCompletionAtRisk = (booking, now = new Date(), nextSlotStartAt = null) => {
  if (!nextSlotStartAt) return false;
  const riskAt = new Date(
    new Date(nextSlotStartAt).getTime() - REPLACEMENT_SEARCH_MINUTES * 60 * 1000
  );
  return projectedReadyAt(booking, now).getTime() > riskAt.getTime();
};

export const findBackupCandidate = async (booking, { excludeTechnicianId = null, io = null } = {}) => {
  if (!booking?.slotKey) return null;
  const address = {
    ...(booking.addressSnapshot || {}),
    latitude: booking.addressSnapshot?.latitude ?? booking.location?.coordinates?.[1],
    longitude: booking.addressSnapshot?.longitude ?? booking.location?.coordinates?.[0],
    cityZoneId: booking.cityZoneId,
  };

  const candidateIds = await findEligibleTechniciansForService({
    serviceId: booking.serviceId,
    address,
    radiusMeters: undefined,
    enableGeo: false,
    limit: 50,
    bookingType: "schedule",
    cityZoneId: booking.cityZoneId,
  });

  const filtered = candidateIds
    .map(String)
    .filter((id) => String(id) !== String(excludeTechnicianId || booking.technicianId));

  if (!filtered.length) return null;

  const busy = await TechnicianSlot.find({
    technicianId: { $in: filtered.map((id) => new mongoose.Types.ObjectId(id)) },
    slotKey: booking.slotKey,
    active: true,
  })
    .select("technicianId")
    .lean();
  const busySet = new Set(busy.map((row) => String(row.technicianId)));

  const dayStart = startOfBusinessDayUtc(booking.slotStartAt);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const daily = await TechnicianSlot.aggregate([
    {
      $match: {
        technicianId: { $in: filtered.map((id) => new mongoose.Types.ObjectId(id)) },
        active: true,
        slotStartAt: { $gte: dayStart, $lt: dayEnd },
      },
    },
    { $group: { _id: "$technicianId", count: { $sum: 1 } } },
  ]);
  const dailyMap = new Map(daily.map((row) => [String(row._id), row.count]));

  const profiles = await TechnicianProfile.find({
    _id: { $in: filtered.map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .select("_id notificationPreferences")
    .lean();
  const prefsById = new Map(profiles.map((p) => [String(p._id), p.notificationPreferences || {}]));

  for (const id of filtered) {
    if (busySet.has(id)) continue;
    const maxDaily = prefsById.get(id)?.maxScheduledJobsPerDay ?? MAX_SCHEDULED_JOBS_PER_DAY_DEFAULT;
    if ((dailyMap.get(id) || 0) >= maxDaily) continue;
    return id;
  }
  return null;
};

/**
 * Backup-first late-completion handling. The original technician remains
 * assigned until a backup accepts; this only reserves the backup slot and
 * sends the offer. If no backup is found, the original is kept and the
 * customer/admin are warned (never blind-release).
 */
export const startBackupSearch = async (booking, io = null) => {
  if (!booking?.slotKey || !booking.slotStartAt || !booking.slotEndAt) {
    return { offered: false, reason: "slot_missing" };
  }
  const now = new Date();
  const backupWindowClosesAt = new Date(
    new Date(booking.slotStartAt).getTime() - 15 * 60 * 1000
  );
  if (now >= backupWindowClosesAt) {
    return { offered: false, reason: "backup_window_closed" };
  }

  const existing = await TechnicianSlot.findOne({
    bookingId: booking._id,
    role: "backup",
    active: true,
  }).lean();
  if (existing) {
    const activeOffer = await JobBroadcast.findOne({
      bookingId: booking._id,
      technicianId: existing.technicianId,
      status: "sent",
      expiresAt: { $gt: now },
    }).lean();
    if (activeOffer) {
      return { offered: true, technicianId: existing.technicianId, existing: true };
    }
    await TechnicianSlot.updateOne(
      { _id: existing._id, active: true },
      {
        $set: {
          active: false,
          releasedAt: now,
          releaseReason: "backup_offer_expired",
        },
      }
    );
    await ServiceBooking.updateOne(
      { _id: booking._id },
      {
        $set: {
          backupTechnicianId: null,
          backupTechnicianSlotId: null,
        },
      }
    );
  }

  const backupTechnicianId = await findBackupCandidate(booking, { io });
  if (!backupTechnicianId) return { offered: false, reason: "no_backup_candidate" };

  let backupSlot;
  try {
    [backupSlot] = await TechnicianSlot.create([
      {
        technicianId: backupTechnicianId,
        bookingId: booking._id,
        slotKey: booking.slotKey,
        slotStartAt: booking.slotStartAt,
        slotEndAt: booking.slotEndAt,
        role: "backup",
        active: true,
        source: "replacement",
        capacityKeys: [],
        metadata: { reason: "late_completion" },
      },
    ]);
  } catch (error) {
    if (error?.code === 11000) {
      return { offered: false, reason: "backup_conflict" };
    }
    throw error;
  }

  await ServiceBooking.updateOne(
    { _id: booking._id },
    {
      $set: {
        lateCompletionAtRisk: true,
        lateCompletionDetectedAt: new Date(),
        originalTechnicianId: booking.technicianId || null,
        backupTechnicianId,
        backupTechnicianSlotId: backupSlot._id,
      },
    }
  );

  const expiresAt = new Date(
    new Date(booking.slotStartAt).getTime() - 15 * 60 * 1000
  );
  await JobBroadcast.updateOne(
    { bookingId: booking._id, technicianId: backupTechnicianId },
    {
      $set: {
        status: "sent",
        expiresAt,
        purgeAt: auditPurgeAt(),
        respondedAt: null,
        expiredAt: null,
        expiredReason: null,
        lastPushedAt: null,
        lastPushedVersion: null,
      },
      $inc: { version: 1 },
    },
    { upsert: true }
  );

  await notifyTechnicianWithFallback(
    io,
    backupTechnicianId,
    {
      event: "booking:backup_offer",
      data: {
        bookingId: booking._id,
        message: "A scheduled job in your area needs a backup technician. Accept to take over.",
        type: "BACKUP_OFFER",
        slotKey: booking.slotKey,
        slotLabel: booking.slotLabel,
      },
      pushTitle: "Backup job available",
      pushBody: `A job needs a backup for ${booking.slotLabel || "an upcoming slot"}.`,
    },
    true
  ).catch(() => {});

  emitJobsChanged(io, backupTechnicianId, {
    action: "backup_offer",
    bookingId: booking._id,
  });

  return { offered: true, technicianId: backupTechnicianId, backupSlotId: backupSlot._id };
};

/**
 * Called after a backup accepts. Releases the original technician's slot and
 * promotes the backup reservation to primary. The booking's hold/capacity is
 * unchanged (already confirmed).
 */
export const promoteBackup = async ({ booking, backupTechnicianId, technicianSnapshot = null, session = null }) => {
  const backupSlot = await TechnicianSlot.findOne({
    bookingId: booking._id,
    technicianId: backupTechnicianId,
    role: "backup",
    active: true,
  }).session(session);
  if (!backupSlot) {
    const error = new Error("Backup slot reservation not found");
    error.statusCode = 409;
    error.code = "BACKUP_SLOT_MISSING";
    throw error;
  }

  const originalTechnicianId = booking.technicianId;
  await TechnicianSlot.updateMany(
    { bookingId: booking._id, active: true, role: "primary" },
    {
      $set: {
        active: false,
        releasedAt: new Date(),
        releaseReason: "late_completion_replaced",
      },
    },
    { session }
  );
  backupSlot.role = "primary";
  backupSlot.source = "replacement";
  await backupSlot.save({ session });

  await ServiceBooking.updateOne(
    { _id: booking._id },
    {
      $set: {
        technicianId: backupTechnicianId,
        originalTechnicianId,
        replacementTechnicianId: backupTechnicianId,
        backupTechnicianId: null,
        backupTechnicianSlotId: null,
        lateCompletionAtRisk: false,
        status: "accepted",
        assignmentStatus: "assigned",
        assignedAt: new Date(),
        ...(technicianSnapshot ? { technicianSnapshot } : {}),
      },
      $push: {
        assignmentAttempts: {
          technicianId: backupTechnicianId,
          attemptNumber: (booking.assignmentAttempts?.length || 0) + 1,
          status: "assigned",
          acceptedAt: new Date(),
          releaseReason: "late_completion_replacement",
        },
      },
      $inc: { version: 1 },
    },
    { session }
  );

  return { originalTechnicianId, backupTechnicianId };
};

export const runLateCompletionWatchdog = async ({ io = null, now = new Date(), limit = 50 } = {}) => {
  const bookings = await ServiceBooking.find({
    bookingType: "schedule",
    status: "in_progress",
    technicianId: { $ne: null },
    $or: [
      { lateCompletionAtRisk: { $ne: true } },
      { backupTechnicianId: null },
    ],
  })
    .select("_id technicianId serviceId districtId cityZoneId slotKey slotStartAt slotEndAt slotLabel estimatedDurationMinutes inProgressAt reachedAt onTheWayAt location addressSnapshot")
    .limit(limit)
    .lean();

  const results = [];
  for (const booking of bookings) {
    const nextSlot = await findNextActiveSlotForTechnician({
      technicianId: booking.technicianId,
      from: booking.slotEndAt
        ? new Date(new Date(booking.slotEndAt).getTime() + 1)
        : now,
    });
    if (!isLateCompletionAtRisk(booking, now, nextSlot?.slotStartAt)) continue;
    await markLateCompletionAtRisk({
      bookingId: booking._id,
      technicianId: booking.technicianId,
      slotKey: booking.slotKey,
    });
    const offer = await startBackupSearch(booking, io);
    if (!offer.offered) {
      if (io) {
        io.to("admin_dashboard").emit("booking_at_risk", {
          bookingId: booking._id,
          technicianId: booking.technicianId,
          slotKey: booking.slotKey,
          type: "LATE_COMPLETION_NO_BACKUP",
        });
      }
    }
    results.push({ bookingId: booking._id, ...offer });
  }
  return results;
};
