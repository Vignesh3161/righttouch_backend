import cron from "node-cron";
import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import TechnicianBookingOffer from "../Schemas/TechnicianBookingOffer.js";
import { matchAndBroadcastBooking } from "./technicianMatching.js";
import User from "../Schemas/User.js";
import sendSms from "./sendSMS.js";
import { notifyTechnicianWithFallback, emitJobsChanged, emitJobExpired } from "./sendNotification.js";
import { toBookingCancelledDTO } from "./socketDTO.js";
import { sendScheduledReminder, notifyCustomerOfRebroadcast } from "./sendReminder.js";
import { normalizeBookingStatus } from "./bookingStatus.js";

const LEASE_TTL_MS = 2 * 60 * 1000; // worker claim TTL (crash recovery)
const MAX_RELEASES_BEFORE_CANCEL = 2; // instant OTW-timeout policy

/** 🔌 Skip cron work while Mongo is disconnected (avoids 10s buffer timeouts). */
const dbReady = () => mongoose.connection.readyState === 1;

/**
 * 🔒 ATOMIC WORKER LEASE — multi-instance safe claim.
 * Only one cron instance may process a booking at a time; crashed workers
 * have their lease expire and get reclaimed.
 */
const claimLease = async (bookingId, owner, ttlMs = LEASE_TTL_MS) => {
  const now = new Date();
  const result = await ServiceBooking.findOneAndUpdate(
    {
      _id: bookingId,
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
    },
    { $set: { leaseUntil: new Date(now.getTime() + ttlMs), leaseOwner: owner } },
    { new: true }
  );
  return result;
};

const releaseLease = async (bookingId) => {
  await ServiceBooking.updateOne(
    { _id: bookingId },
    { $set: { leaseUntil: null, leaseOwner: null } }
  );
};

/**
 * Helper to notify customer via Socket/Push (Avoid SMS to prevent OTP mangling)
 */
const notifyCustomer = async (booking, message, io) => {
    try {
        if (!booking.customerId) return;

        // Push notification is free and safe for custom text
        const { sendPushNotification } = await import("./sendNotification.js");
        await sendPushNotification(booking.customerId.toString(), {
            title: "Booking Update",
            body: message,
            data: { bookingId: booking._id.toString(), type: "BOOKING_UPDATE" }
        }, { recipientType: "customer" });

        // Socket for real-time — room-scoped DTO only (never global io.emit)
        if (io) {
            io.to(`customer_${booking.customerId}`).emit("booking_cancelled", {
                ...toBookingCancelledDTO(booking, booking.cancelReason || "no_technician_accept"),
                message
            });
        }
    } catch (err) {
        console.error("notifyCustomer error:", err.message);
    }
};

/** Release an assigned technician (atomic, idempotent) and record history. */
const releaseTechnicianAssignment = async (bookingId, releaseReason) => {
  const now = new Date();
  const booking = await ServiceBooking.findOneAndUpdate(
    {
      _id: bookingId,
      status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
      technicianId: { $ne: null },
    },
    {
      $set: {
        technicianId: null,
        status: "pending",
        assignmentStatus: "unassigned",
        autoCancelAt: new Date(now.getTime() + 5 * 60 * 1000),
      },
      $inc: { version: 1 },
    },
    { new: true }
  );

  if (booking) {
    await ServiceBooking.updateOne(
      { _id: bookingId },
      {
        $push: {
          assignmentAttempts: {
            technicianId: booking.technicianId, // value captured pre-release
            attemptNumber: (booking.assignmentAttempts?.length || 0) + 1,
            status: "released",
            acceptedAt: booking.assignedAt || null,
            releasedAt: now,
            releaseReason,
          },
        },
      }
    );
  }
  return booking;
};

/**
 * 🛰 Expire every broadcast + offer for a booking, bump the affected
 * technicians' feed cursors, then notify them live:
 *   - technician:jobs_changed (refetch once)
 *   - job:expired (drop the card instantly — Location Pipeline P1.5)
 * Shared by ALL expiry paths (auto-cancel, OTW timeout, travel no-show).
 */
const expireBroadcastsForBooking = async (io, bookingId, reason, expiresAt = new Date()) => {
  try {
    await JobBroadcast.updateMany(
      { bookingId },
      { $set: { status: "expired" } }
    );
    await TechnicianBookingOffer.updateMany(
      { bookingId, decision: "offered" },
      { $set: { decision: "expired" } }
    );

    const affectedTechs = await JobBroadcast.find({ bookingId }).distinct("technicianId");
    if (affectedTechs.length > 0) {
      await TechnicianProfile.updateMany(
        { _id: { $in: affectedTechs } },
        { $set: { lastJobsChangeAt: new Date() } }
      );
      affectedTechs.forEach((techId) => {
        emitJobsChanged(io, techId);
        emitJobExpired(io, techId, { bookingId, expiresAt, reason });
      });
    }
    return affectedTechs;
  } catch (err) {
    console.error(`[Cron:Expiry] expireBroadcastsForBooking failed for ${bookingId}:`, err.message);
    return [];
  }
};

export const initBookingCrons = (io) => {
    console.log("⏰ Initializing consolidated booking crons...");

    /**
     * ─── CRON 1: EXPIRY & AUTO-CANCEL (Every 5 mins) ─────────────────────
     * Expires ONLY unassigned bookings whose autoCancelAt has passed.
     * Lease-claimed per booking — safe across multiple app instances.
     * Rechecks state after claiming (never expires an accepted booking).
     * ─────────────────────────────────────────────────────────────────────
     */
    cron.schedule("*/5 * * * *", async () => {
        try {
            if (!dbReady()) return;
            const now = new Date();
            const expiredJobs = await ServiceBooking.find({
                status: { $in: ["pending", "broadcasted"] },
                autoCancelAt: { $lte: now },
                technicianId: null,
            }).select("_id").limit(100);

            for (const { _id } of expiredJobs) {
                const claimed = await claimLease(_id, "expiry-worker");
                if (!claimed) continue;

                try {
                    // RECHECK — the booking may have been accepted between the
                    // query and the lease claim. Never expire an accepted job.
                    const fresh = await ServiceBooking.findById(_id)
                      .select("status technicianId autoCancelAt bookingType cancelReason")
                      .lean();
                    if (
                      !fresh ||
                      fresh.technicianId !== null ||
                      !["pending", "broadcasted"].includes(normalizeBookingStatus(fresh.status)) ||
                      !fresh.autoCancelAt ||
                      fresh.autoCancelAt > now
                    ) {
                      continue;
                    }

                    await ServiceBooking.updateOne(
                      { _id },
                      {
                        $set: {
                          status: "expired",
                          cancelReason: "no_technician_accept",
                          cancelledBy: "system",
                          cancellationStatus: "system_cancelled",
                          assignmentStatus: "released",
                        },
                        $inc: { version: 1 },
                      }
                    );

                    // Batch: expire all broadcasts + offers for this booking,
                    // bump cursors, and tell live techs the offer died
                    // (jobs_changed + job:expired).
                    await expireBroadcastsForBooking(io, _id, "no_technician_accept", now);

                    const message = fresh.bookingType === "instant"
                        ? "We couldn't find a technician for your immediate booking. It has expired. Please try again later."
                        : "No technician accepted your scheduled booking 5 hours before the start. It has been cancelled automatically.";
                    await notifyCustomer(claimed, message, io);
                    console.log(`[Cron:Expiry] Auto-cancelled ${fresh.bookingType} job ${_id}`);
                } finally {
                    await releaseLease(_id);
                }
            }
        } catch (err) {
            console.error("[Cron:Expiry Error]", err);
        }
    });

    /**
     * ─── CRON 2: RE-BROADCAST / REMINDERS (Every 10 mins) ──────────────────
     * Oldest eligible unassigned bookings first. Lease-claimed. Each
     * matchAndBroadcastBooking increments the broadcast version (so stale
     * accept claims fail and notifications dedupe on the version).
     * ──────────────────────────────────────────────────────────────────────
     */
    cron.schedule("*/10 * * * *", async () => {
        try {
            if (!dbReady()) return;
            const now = new Date();
            const jobsToBroadcast = await ServiceBooking.find({
                status: { $in: ["pending", "broadcasted"] },
                technicianId: null,
                autoCancelAt: { $gt: now },
            }).select("_id").sort({ createdAt: 1 }).limit(20);

            for (const { _id } of jobsToBroadcast) {
                const claimed = await claimLease(_id, "rebroadcast-worker");
                if (!claimed) continue;
                try {
                    await matchAndBroadcastBooking(_id, io);
                    console.log(`[Cron:Broadcast] Re-broadcasted job ${_id}`);
                } finally {
                    await releaseLease(_id);
                }
            }
        } catch (err) {
            console.error("[Cron:Broadcast Error]", err);
        }
    });

    /**
     * ─── CRON 3: INSTANT ON-THE-WAY TIMEOUT (Every 1 min) ─────────────────
     * DOCUMENTED POLICY: an instant booking accepted by a technician must be
     * started (On The Way) within 30 minutes. If not:
     *   - 1st timeout: release + re-dispatch (recorded in assignmentAttempts)
     *   - 2nd timeout: release + re-dispatch (recorded)
     *   - 3rd timeout: cancel with technician_no_action + notify customer
     * No penalty is debited here (technician fault handling is explicit in
     * technician cancellation); this is a release policy, not a money event.
     * ──────────────────────────────────────────────────────────────────────
     */
    cron.schedule("* * * * *", async () => {
        try {
            if (!dbReady()) return;
            const now = new Date();
            const timedOut = await ServiceBooking.find({
                status: "accepted",
                bookingType: "instant",
                autoCancelAt: { $lte: now, $ne: null },
                technicianId: { $ne: null },
            }).select("_id technicianId").limit(50);

            for (const { _id } of timedOut) {
                const claimed = await claimLease(_id, "otw-timeout-worker");
                if (!claimed) continue;
                try {
                    const fresh = await ServiceBooking.findById(_id)
                      .select("status autoCancelAt technicianId assignmentAttempts cancelReason")
                      .lean();
                    if (!fresh || fresh.status !== "accepted" || fresh.technicianId == null || !fresh.autoCancelAt || fresh.autoCancelAt > now) {
                        continue;
                    }

                    const releasedCount = (fresh.assignmentAttempts || []).filter(
                      (a) => a.status === "released" && a.releaseReason === "on_the_way_timeout"
                    ).length;

                    if (releasedCount >= MAX_RELEASES_BEFORE_CANCEL) {
                        // Policy escalation: cancel with technician fault.
                        await ServiceBooking.updateOne(
                          { _id },
                          {
                            $set: {
                              status: "cancelled",
                              cancelReason: "technician_no_action",
                              cancelledBy: "system",
                              cancellationStatus: "system_cancelled",
                              technicianId: null,
                              assignmentStatus: "released",
                              autoCancelAt: null,
                            },
                            $inc: { version: 1 },
                          }
                        );
                        await expireBroadcastsForBooking(io, _id, "technician_no_action");
                        await notifyCustomer(
                          claimed,
                          "The technician did not start the job in time, so your booking was cancelled. Please book again.",
                          io
                        );
                        console.log(`[Cron:OTWTimeout] Cancelled ${_id} (3rd release)`);
                        continue;
                    }

                    // Release + re-dispatch (keeps original booking ID + history)
                    await ServiceBooking.updateOne(
                      { _id },
                      {
                        $set: {
                          technicianId: null,
                          status: "pending",
                          assignmentStatus: "unassigned",
                          autoCancelAt: new Date(now.getTime() + 5 * 60 * 1000),
                        },
                        $push: {
                          assignmentAttempts: {
                            technicianId: fresh.technicianId,
                            attemptNumber: (fresh.assignmentAttempts?.length || 0) + 1,
                            status: "released",
                            acceptedAt: claimed.assignedAt || null,
                            releasedAt: now,
                            releaseReason: "on_the_way_timeout",
                          },
                        },
                        $inc: { version: 1 },
                      }
                    );
                    await expireBroadcastsForBooking(io, _id, "on_the_way_timeout", now);
                    await matchAndBroadcastBooking(_id, io);
                    await notifyCustomer(
                      claimed,
                      "Your technician did not start travel in time. We are finding you a new technician.",
                      io
                    );
                    console.log(`[Cron:OTWTimeout] Released + re-dispatched ${_id} (release #${releasedCount + 1})`);
                } finally {
                    await releaseLease(_id);
                }
            }
        } catch (err) {
            console.error("[Cron:OTWTimeout Error]", err);
        }
    });

    /**
     * ─── CRON 4: SCHEDULED TRAVEL ENFORCEMENT + ESCALATION (Every 1 min) ──
     * slot −35 min: Start Travel alert (existing, one-shot flag).
     * slot −25 min: second reminder if not travelling yet.
     * slot −15 min: mark at-risk + notify admin dashboard.
     * slot −10 min: reassign if another technician is feasible; otherwise
     *               keep and notify admin (manual escalation).
     * No automatic reassignment once the technician has started travel.
     * ──────────────────────────────────────────────────────────────────────
     */
    cron.schedule("* * * * *", async () => {
        try {
            if (!dbReady()) return;
            const now = new Date();

            // ── −35 min: Start Travel CTA (one-shot) ──
            const alertMin = new Date(now.getTime() + 34 * 60 * 1000);
            const alertMax = new Date(now.getTime() + 40 * 60 * 1000);

            const pendingAlerts = await ServiceBooking.find({
                status: { $in: ["accepted", "on_the_way"] },
                bookingType: "schedule",
                scheduledAt: { $gte: alertMin, $lte: alertMax },
                "remindersSent.enforceOTW": false,
                technicianId: { $ne: null },
            });

            for (const b of pendingAlerts) {
                const ctaMessage = "Your scheduled job starts in 35 minutes. Please click 'Yes' to start your travel now.";

                await notifyTechnicianWithFallback(io, b.technicianId.toString(), {
                    event: "booking:travel_reminder",
                    data: { bookingId: b._id, message: ctaMessage, type: "START_TRAVEL_CTA" },
                    pushTitle: "🕒 Travel Reminder",
                    pushBody: ctaMessage,
                    smsMessage: `Urgent: Your job ${b._id} starts in 35 mins. Please start travel now.`
                }, true);

                await notifyCustomer(b, "Your technician has been alerted and is starting travel for your scheduled job.", io);

                // Atomic one-shot — only the worker that flips the flag delivers.
                const updated = await ServiceBooking.updateOne(
                    { _id: b._id, "remindersSent.enforceOTW": false },
                    { $set: { "remindersSent.enforceOTW": true, enforcementAlertAt: now } }
                );
                if (updated.modifiedCount > 0) {
                    console.log(`[Cron:Enforcement] Dual travel reminders sent for job ${b._id}`);
                }
            }

            // ── Escalation ladder for technicians who never start travel ──
            const escalationStages = [
                { flag: "escalate25", mins: 25, step: 1 },
                { flag: "escalate15", mins: 15, step: 2 },
                { flag: "escalate10", mins: 10, step: 3 },
            ];

            for (const stage of escalationStages) {
                const stageMin = new Date(now.getTime() + (stage.mins - 1) * 60 * 1000);
                const stageMax = new Date(now.getTime() + (stage.mins + 5) * 60 * 1000);
                const atRisk = await ServiceBooking.find({
                    status: { $in: ["accepted"] },
                    bookingType: "schedule",
                    scheduledAt: { $gte: stageMin, $lte: stageMax },
                    [`remindersSent.${stage.flag}`]: false,
                    technicianId: { $ne: null },
                }).select("_id technicianId scheduledAt");

                for (const b of atRisk) {
                    const claimed = await claimLease(b._id, `escalation-${stage.flag}`);
                    if (!claimed) continue;
                    try {
                        const fresh = await ServiceBooking.findById(b._id)
                          .select("status scheduledAt remindersSent technicianId")
                          .lean();
                        if (!fresh || fresh.status !== "accepted" || fresh.technicianId == null ||
                            fresh.remindersSent?.[stage.flag]) {
                            continue;
                        }

                        if (stage.step === 1) {
                            // −25 min: second reminder
                            await notifyTechnicianWithFallback(io, fresh.technicianId.toString(), {
                                event: "booking:travel_escalation",
                                data: { bookingId: b._id, message: "Your job starts in 25 minutes — please start travel now.", type: "START_TRAVEL_URGENT" },
                                pushTitle: "⏰ Job starts in 25 min",
                                pushBody: "Please start travel now.",
                                smsMessage: `Your job starts in 25 mins. Please start travel now.`
                            }, true);
                        } else if (stage.step === 2) {
                            // −15 min: at-risk → notify admin dashboard
                            await notifyCustomer(claimed, "Your technician hasn't started travel yet. We are monitoring this booking.", io);
                            if (io) {
                                io.to("admin_dashboard").emit("booking_at_risk", {
                                    bookingId: b._id,
                                    technicianId: fresh.technicianId,
                                    scheduledAt: fresh.scheduledAt,
                                    type: "SCHEDULED_AT_RISK",
                                });
                            }
                        } else {
                            // −10 min: reassign if feasible; otherwise manual escalation.
                            const released = await releaseTechnicianAssignment(b._id, "schedule_travel_no_show");
                            if (released) {
                                await expireBroadcastsForBooking(io, b._id, "schedule_travel_no_show");
                                await matchAndBroadcastBooking(b._id, io);
                                await notifyCustomer(claimed, "Your technician hasn't started travel. We are finding a replacement.", io);
                            } else {
                                if (io) {
                                    io.to("admin_dashboard").emit("booking_at_risk", {
                                        bookingId: b._id,
                                        technicianId: fresh.technicianId,
                                        scheduledAt: fresh.scheduledAt,
                                        type: "SCHEDULED_MANUAL_ESCALATION",
                                    });
                                }
                            }
                        }

                        await ServiceBooking.updateOne(
                            { _id: b._id, [`remindersSent.${stage.flag}`]: false },
                            { $set: { [`remindersSent.${stage.flag}`]: true } }
                        );
                    } finally {
                        await releaseLease(b._id);
                    }
                }
            }
        } catch (err) {
            console.error("[Cron:Enforcement Error]", err);
        }
    });

    /**
     * ─── CRON 5: SCHEDULED REMINDERS (Every 1 min) ─────────────────────────
     * Fires h24 (24h before), h1 (1h before), min15 (15min before) reminders
     * to assigned technicians. Each reminder is atomic and one-shot — the
     * flag flips only if it was still false (multi-instance safe).
     * ──────────────────────────────────────────────────────────────────────
     */
    cron.schedule("* * * * *", async () => {
        try {
            if (!dbReady()) return;
            const now = new Date();

            const reminderSpecs = [
                { flag: "h24", minOffsetMin: 23 * 60 + 50, maxOffsetMin: 24 * 60 + 10 },
                { flag: "h1", minOffsetMin: 55, maxOffsetMin: 65 },
                { flag: "min15", minOffsetMin: 13, maxOffsetMin: 17 },
            ];

            for (const spec of reminderSpecs) {
                const rMin = new Date(now.getTime() + spec.minOffsetMin * 60 * 1000);
                const rMax = new Date(now.getTime() + spec.maxOffsetMin * 60 * 1000);
                const bookings = await ServiceBooking.find({
                    status: { $in: ["accepted"] },
                    bookingType: "schedule",
                    scheduledAt: { $gte: rMin, $lte: rMax },
                    [`remindersSent.${spec.flag}`]: false,
                    technicianId: { $ne: null },
                }).select("_id").limit(100);

                for (const { _id } of bookings) {
                    const b = await ServiceBooking.findById(_id);
                    if (!b) continue;
                    await sendScheduledReminder(b, spec.flag, io);
                    // Atomic one-shot — only flips if still false.
                    await ServiceBooking.updateOne(
                        { _id, [`remindersSent.${spec.flag}`]: false },
                        { $set: { [`remindersSent.${spec.flag}`]: true } }
                    );
                }
            }
        } catch (err) {
            console.error("[Cron:Reminders Error]", err);
        }
    });

    console.log("✅ Consolidated booking crons are active.");
};
