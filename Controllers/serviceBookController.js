import ServiceBooking from "../Schemas/ServiceBooking.js";
import User from "../Schemas/User.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianSlot from "../Schemas/TechnicianSlot.js";
import TechnicianBookingOffer from "../Schemas/TechnicianBookingOffer.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import SlotHold from "../Schemas/SlotHold.js";
import Service from "../Schemas/Service.js";
import Address from "../Schemas/Address.js";
import mongoose from "mongoose";
import { broadcastJobToTechnicians } from "../Utils/sendNotification.js";
import { notifyCustomerJobAccepted } from "../Utils/sendNotification.js";
import { broadcastPendingJobsToTechnician, findEligibleTechniciansForService, loadCommittedQueues, evaluateJobFeasibility } from "../Utils/technicianMatching.js";
import { findNearbyTechnicians } from "../Utils/findNearbyTechnicians.js";
import { settleBookingEarningsIfEligible } from "../Utils/settlement.js";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";
import { resolveZoneFromCoordinates } from "../Utils/resolveZoneFromCoordinates.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import BookingOutbox from "../Schemas/BookingOutbox.js";
import DispatchOutbox from "../Schemas/DispatchOutbox.js";
import { checkTechnicianActivation } from "../Utils/technicianActivation.js";
import { canTransition, normalizeBookingStatus } from "../Utils/bookingStatus.js";
import { resolveCommissionSnapshot } from "../Utils/commission.js";
import { paiseToRupees, percentageOf, toPaise, isPayableTotalPaise } from "../Utils/money.js";
import { toBookingCreatedDTO, toBookingCancelledDTO } from "../Utils/socketDTO.js";
import { notifyCustomerOfRebroadcast } from "../Utils/sendReminder.js";
import {
  resolveScheduleInput,
  resolveServiceZoneAvailability,
  buildServiceBookingDoc,
  createBookingAndOutbox,
  broadcastCreatedBooking,
  computeAutoCancelAt,
  resolveBookingIdempotencyKey,
  findBookingByIdempotencyKey,
  findBookingByIdempotencyKeyWithRetry,
  isDuplicateKeyError,
} from "../Utils/bookingService.js";
import { writeAuditLog } from "../Utils/audit.js";
import { getBookingSchedulePayload, getSlotForTime } from "../Utils/slots.js";
import {
  computeDispatchEligibleAt,
  RESCHEDULE_CUTOFF_MINUTES,
  SCHEDULED_REDISPATCH_WINDOW_MINUTES,
  MAX_RESCHEDULES_PER_BOOKING,
} from "../Utils/schedulingConfig.js";
import { checkTechnicianEligibility, getTechnicianOrigin } from "../Services/technicianEligibilityService.js";
import { getSlotAvailability, assertServiceFitsSlot } from "../Services/slotAvailabilityService.js";
import {
  prepareScheduledBooking,
  releaseScheduledSlot,
  acquireSlotCapacity,
  releaseSlotCapacity,
  getActiveHoldForBooking,
  revertConfirmedCapacityToHeld,
} from "../Services/slotCapacityService.js";
import { containsRegex } from "../Utils/safeQuery.js";
import { getReacceptPenaltyPercent } from "./adminSettingsController.js";
import {
  requestCompletionOtp as requestCompletionOtpService,
  resendCompletionOtp as resendCompletionOtpService,
  verifyCompletionOtp as verifyCompletionOtpService,
  getCompletionStatus as getCompletionStatusService,
  completionAccessError,
} from "../Services/completionVerificationService.js";
import { closeActiveChallengesForBooking } from "../Utils/completionOtp.js";
import { evaluateReacceptEligibility } from "../Utils/bookingReaccept.js";
import { haversineMeters } from "../Utils/feasibility.js";
import { getCallLogForNoShow } from "../Services/callLogService.js";
import {
  CUSTOMER_NO_SHOW_WAIT_MINUTES,
  CUSTOMER_NO_SHOW_RESPONSE_MINUTES,
  CUSTOMER_NO_SHOW_GEOFENCE_METERS,
  CUSTOMER_NO_SHOW_COMPENSATION_ENABLED,
  CUSTOMER_NO_SHOW_COMPENSATION_PERCENT,
  CUSTOMER_NO_SHOW_MIN_COMPENSATION_PAISE,
} from "../Utils/schedulingConfig.js";

const DISPATCH_LOCK_MS = 10000;

const REACCEPT_REJECT_MESSAGES = {
  not_cancelled: "Only cancelled jobs can be re-accepted",
  not_technician_cancelled: "Only jobs cancelled by you can be re-accepted",
  reaccept_disabled: "This cancellation is not eligible for re-acceptance",
  reaccept_window_expired: "The re-accept window has expired",
  scheduled_time_passed: "This scheduled slot has already passed",
  missing_cancellation_time: "The cancellation time is unavailable",
  missing_scheduled_at: "This scheduled booking has no valid slot",
};

const sendScheduleReplay = (res, booking) =>
  res.status(200).json({
    success: true,
    message: "Booking already created",
    result: {
      bookingId: booking._id,
      bookingType: booking.bookingType === "schedule" ? "scheduled" : "instant",
      status: booking.status,
      scheduledAt: booking.scheduledAt,
      scheduledDateLocal: booking.scheduledDateLocal,
      scheduledTimeLocal: booking.scheduledTimeLocal,
      timezone: booking.timezone,
      broadcastCount: 0,
      deduped: true,
    },
  });

/**
 * Post-commit completion side effects — the EXISTING completion behavior,
 * byte-for-byte in outcome: idempotent settlement attempt, customer push +
 * socket, rebroadcast of pending jobs to this technician. Called ONLY from
 * the OTP-verified completion path (verifyCompletionOtp below). Kept as a
 * single function so completion can never notify/settle twice.
 */
export const fireBookingCompletedSideEffects = async (booking, technicianProfileId, io) => {
  // Post-completion side effects must never turn a successful OTP
  // verification into an error response.
  try {
    // If payment is already verified, credit technician wallet (idempotent)
    await settleBookingEarningsIfEligible(booking._id);
  } catch (settleErr) {
    console.error("settleBookingEarningsIfEligible error:", settleErr.message);
  }

  // Notify customer — service is complete (payment was captured before OTP).
  if (booking.customerId) {
    try {
      const { sendAppNotification } = await import("../Services/unifiedNotificationService.js");
      await sendAppNotification({
        userId: booking.customerId.toString(),
        recipientType: "customer",
        type: "BOOKING_COMPLETED",
        title: "Service Completed",
        message: "Your service is complete. Thank you!",
        bookingId: booking._id,
        metadata: { socketEvent: "booking:completed", stage: "service_completed" },
        priority: "high",
        category: "booking",
        io,
      });
    } catch (notifyErr) {
      console.error("notifyCustomerCompleted error:", notifyErr.message);
    }
    if (io) {
      io.to(`customer_${booking.customerId}`).emit("booking_completed", {
        bookingId: booking._id,
        message: "Service completed successfully",
        type: "BOOKING_COMPLETED",
      });
    }
  }

  // Re-broadcast pending jobs to this technician only
  try {
    const busyStartTime = booking.assignedAt || booking.createdAt || null;
    await broadcastPendingJobsToTechnician(technicianProfileId, io, busyStartTime);
  } catch (broadcastErr) {
    console.error("broadcastPendingJobsToTechnician error:", broadcastErr.message);
  }
};

const toNumber = value => {
  const num = Number(value);
  return Number.isNaN(num) ? NaN : num;
};


const toFiniteNumber = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const createBooking = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }
    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
    }
    const customerId = req.user.userId;

    const { serviceId, baseAmount } = req.body;
    const radiusInput = toFiniteNumber(req.body?.radius);
    const addressId = typeof req.body?.addressId === "string" ? req.body.addressId.trim() : req.body?.addressId;
    const addressLineInput = typeof req.body?.addressLine === "string" ? req.body.addressLine.trim() : "";

    const latInput =
      req.body?.latitude !== undefined
        ? toFiniteNumber(req.body.latitude)
        : toFiniteNumber(req.body?.location?.latitude);
    const lngInput =
      req.body?.longitude !== undefined
        ? toFiniteNumber(req.body.longitude)
        : toFiniteNumber(req.body?.location?.longitude);
    const hasCoords = latInput !== null && lngInput !== null;

    // ─── Booking type & scheduled time ───────────────────────────────
    const schedule = resolveScheduleInput(req.body);
    if (schedule.error) {
      return res.status(400).json({ success: false, message: schedule.error, result: {} });
    }
    const bookingType = schedule.bookingType === "schedule" ? "scheduled" : "instant";
    const finalScheduledAt = schedule.scheduledAt || null;

    if (!serviceId || baseAmount == null || (!req.body?.address && !addressId && !addressLineInput && !hasCoords)) {
      return res.status(400).json({
        success: false,
        message: "All fields required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId format", result: {} });
    }

    const baseAmountNum = toNumber(baseAmount);
    if (Number.isNaN(baseAmountNum) || baseAmountNum < 0) {
      return res.status(400).json({ success: false, message: "baseAmount must be a non-negative number", result: {} });
    }

    const service = await Service.findById(serviceId);
    if (!service || !service.isActive) {
      return res.status(404).json({ success: false, message: "Service not found or inactive", result: {} });
    }

    const resolvedLocation = await resolveUserLocation({
      locationType: req.body.locationType,
      addressId: req.body.addressId,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      userId: customerId,
    });

    if (!resolvedLocation.success) {
      return res.status(resolvedLocation.statusCode).json({
        success: false,
        message: resolvedLocation.message,
        result: {},
      });
    }

    // 🏘 ZONE RESOLUTION — FINAL RULE: every booking needs coordinates that
    // resolve to District + active Zone + enabled service. No coords → block.
    let resolvedZoneId = null;
    let resolvedDistrictId = null;
    if (resolvedLocation.latitude && resolvedLocation.longitude) {
      const zoneCheck = await resolveServiceZoneAvailability({
        service,
        latitude: resolvedLocation.latitude,
        longitude: resolvedLocation.longitude,
      });
      if (!zoneCheck.ok) {
        return res.status(400).json({
          success: false,
          message: zoneCheck.error,
          code: zoneCheck.code || "SERVICE_NOT_AVAILABLE",
          result: { reason: zoneCheck.reason },
        });
      }
      resolvedZoneId = zoneCheck.zoneId;
      resolvedDistrictId = zoneCheck.districtId;
    } else {
      return res.status(400).json({
        success: false,
        message: "Service unavailable in this area. This service is currently not available at the selected address.",
        code: "SERVICE_NOT_AVAILABLE",
        result: { reason: "LOCATION_REQUIRED" },
      });
    }

    // 💰 SERVER-SIDE SPLIT — commission on service amount only; GST separate;
    // tip (optional) passes through 100% to the technician.
    // The client can NEVER influence money fields: we take baseAmount/tip only
    // as hints and compute the canonical financial snapshot server-side.
    const snapshot = await resolveCommissionSnapshot({
      booking: { baseAmount: baseAmountNum, itemType: "service" },
      service,
      tipAmountRupees: toFiniteNumber(req.body?.tipAmount) || 0,
    });
    const commissionPct = snapshot.commissionPercentage;
    const commissionAmt = paiseToRupees(snapshot.commissionAmountPaise);
    const techAmt = paiseToRupees(snapshot.technicianAmountPaise);

    // 💸 Fail fast: online payments require a total of ₹0 (free) or at least ₹1.
    const snapshotTotalPaise = toPaise(snapshot.totalAmountPaise);
    if (!isPayableTotalPaise(snapshotTotalPaise)) {
      return res.status(400).json({
        success: false,
        message: `Minimum payable amount is ₹1 (booking total is ₹${(snapshotTotalPaise / 100).toFixed(2)})`,
        result: {},
      });
    }

    // Determine initial status (Production Atomic Flow)
    const now = new Date();
    let autoCancelAt = null;

    if (bookingType === "scheduled" && finalScheduledAt) {
      // Scheduled: Expire 5 hours BEFORE the slot (not after creation)
      autoCancelAt = new Date(finalScheduledAt.getTime() - 5 * 60 * 60 * 1000);
      // Safety: if the slot is less than 5h from now, expire immediately
      if (autoCancelAt <= now) autoCancelAt = new Date(now.getTime() + 5 * 60 * 1000);
    } else {
      // Instant: Expire 1 hour after creation
      autoCancelAt = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    }

    const initialStatus = "pending";

    const bookingDoc = {
      customerId,
      serviceId,
      bookingType: bookingType === "scheduled" ? "schedule" : "instant", // Align with schema enum
      baseAmount: baseAmountNum,
      financialSnapshot: snapshot,
      locationType: resolvedLocation.locationType,
      addressSnapshot: resolvedLocation.addressSnapshot,
      address: resolvedLocation.addressSnapshot.addressLine || "Pinned Location",
      commissionPercentage: commissionPct,
      commissionAmount: commissionAmt,
      technicianAmount: techAmt,
      gstPercentage: snapshot.gstPercentage,
      gstAmount: paiseToRupees(snapshot.gstAmountPaise),
      tipAmount: paiseToRupees(snapshot.tipAmountPaise),
      scheduledAt: finalScheduledAt,
      slotKey: schedule.slotKey || null,
      slotValue: schedule.slotValue || null,
      slotLabel: schedule.slotLabel || null,
      slotStartAt: schedule.slotStartAt || null,
      slotEndAt: schedule.slotEndAt || null,
      estimatedDurationMinutes: service.durationMinutes || 60,
      dispatchEligibleAt: computeDispatchEligibleAt(
        bookingType === "scheduled" ? "schedule" : "instant",
        finalScheduledAt,
        now
      ),
      customerStatusLabel: bookingType === "scheduled" ? "Awaiting technician" : null,
      timezone: schedule.timezone || null,
      scheduledDateLocal: schedule.scheduledDateLocal || null,
      scheduledTimeLocal: schedule.scheduledTimeLocal || null,
      status: initialStatus,
      radius: radiusInput ?? 500,
      faultProblem: typeof req.body?.faultProblem === "string" ? req.body.faultProblem.trim() : null,
      location: {
        type: "Point",
        coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
      },
      broadcastStartedAt: now,
      autoCancelAt: autoCancelAt,
      retryCount: 0,
      technicianRejectCount: 0,
      districtId: resolvedDistrictId,
      cityZoneId: resolvedZoneId,
    };

    if (resolvedLocation.addressId) {
      bookingDoc.addressId = resolvedLocation.addressId;
    }

    let booking;
    let preparedCapacity = null;
    if (bookingDoc.bookingType === "schedule") {
      assertServiceFitsSlot(service.durationMinutes || 60);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const prepared = await prepareScheduledBooking({
            doc: bookingDoc,
            session,
            latitude: resolvedLocation.latitude,
            longitude: resolvedLocation.longitude,
          });
          booking = prepared.booking;
          preparedCapacity = prepared;
        });
      } catch (error) {
        if (preparedCapacity?.releaseCapacity) await preparedCapacity.releaseCapacity();
        throw error;
      } finally {
        await session.endSession();
      }
    } else {
      booking = await ServiceBooking.create(bookingDoc);
    }

    console.log(`\n======================================================================`);
    console.log(`📦 [CUSTOMER BOOKING CREATED]`);
    console.log(`   🆔 Booking ID: ${booking._id}`);
    console.log(`   🛠 Service: ${service.serviceName || serviceId} (ID: ${serviceId})`);
    console.log(`   📍 Customer GPS: [${resolvedLocation.longitude}, ${resolvedLocation.latitude}]`);
    console.log(`   🏢 District ID: ${resolvedDistrictId || "N/A"} | Zone ID: ${resolvedZoneId || "N/A"}`);
    console.log(`   🎯 Matching Radius: 10 KM (10,000 meters)`);
    console.log(`   📅 Type: ${bookingDoc.bookingType} | Initial Status: ${initialStatus}`);
    console.log(`======================================================================`);

    // 🚀 Socket.IO Emission — room-scoped DTO ONLY (Socket Analysis B1.1).
    // The raw booking doc must NEVER be broadcast globally: it contains
    // customer PII (phone, exact address, amounts).
    if (req.io) {
      req.io.to("admin_dashboard").emit("new_booking", toBookingCreatedDTO(booking));
    }

    // 🚀 Immediate Broadcast for searching status
    const broadcastResult = await matchAndBroadcastBooking(booking._id, req.io);

    const schedMsg = bookingType === "scheduled"
      ? `Booking placed for ${schedule.slotLabel || finalScheduledAt.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}. Awaiting technician confirmation.`
      : (broadcastResult.count > 0 ? "Booking created & broadcasted" : "Booking created (no technicians available yet)");

    return res.status(201).json({
      success: true,
      message: schedMsg,
      result: {
        booking,
        broadcastCount: broadcastResult.count ?? 0,
        status: initialStatus,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      code: error.code || undefined,
      result: { error: error.message },
    });
  }
};

/* ================= STORE BOOKING SCHEDULE (DEDICATED) ================= */
export const storeBookingSchedule = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }

    const { serviceId, faultProblem, addressId, locationType, latitude, longitude } = req.body;

    // ─── Schedule resolution (timezone-safe, same utility as GET /slots) ──
    const schedule = resolveScheduleInput(req.body);
    if (schedule.error) {
      return res.status(400).json({ success: false, message: schedule.error, result: {} });
    }

    if (!serviceId) {
      return res.status(400).json({ success: false, message: "serviceId is required", result: {} });
    }

    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", result: {} });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found", result: {} });
    }
    if (!service.isActive) {
      return res.status(400).json({ success: false, message: "Service is not active", result: {} });
    }

    const resolvedLocation = await resolveUserLocation({
      locationType: locationType || (addressId ? "saved" : "gps"),
      addressId: addressId,
      latitude: latitude,
      longitude: longitude,
      userId: req.user.userId,
    });

    if (!resolvedLocation.success) {
      return res.status(resolvedLocation.statusCode).json({
        success: false,
        message: resolvedLocation.message,
        result: {},
      });
    }

    // ─── Zone availability (zone-restricted services need an active mapping) ─
    const zoneCheck = await resolveServiceZoneAvailability({
      service,
      latitude: resolvedLocation.latitude,
      longitude: resolvedLocation.longitude,
    });
    if (!zoneCheck.ok) {
      return res.status(400).json({
        success: false,
        message: zoneCheck.error,
        code: zoneCheck.code || "SERVICE_NOT_AVAILABLE",
        result: { reason: zoneCheck.reason },
      });
    }

    // ─── Build immutable financial snapshot + booking doc (server-side) ────
    const doc = await buildServiceBookingDoc({
      service,
      resolvedLocation,
      schedule,
      tipAmountRupees: toFiniteNumber(req.body?.tipAmount) || 0,
      customerId: req.user.userId,
      faultProblem: faultProblem || null,
      cityZoneId: zoneCheck.zoneId,
      districtId: zoneCheck.districtId,
    });

    // 💸 Fail fast: online payments require a total of ₹0 (free) or at least ₹1.
    const docTotalPaise = toPaise(doc.financialSnapshot?.totalAmountPaise);
    if (!isPayableTotalPaise(docTotalPaise)) {
      return res.status(400).json({
        success: false,
        message: `Minimum payable amount is ₹1 (booking total is ₹${(docTotalPaise / 100).toFixed(2)})`,
        result: {},
      });
    }

    const idempotencyKey = resolveBookingIdempotencyKey({
      req,
      scope: "booking-schedule",
      customerId: String(req.user.userId),
      fingerprint: {
        serviceId: String(serviceId),
        bookingType: schedule.bookingType,
        scheduledAt: schedule.scheduledAt ? schedule.scheduledAt.toISOString() : null,
        addressId: addressId ? String(addressId) : null,
        locationType: locationType || null,
        latitude: resolvedLocation.latitude,
        longitude: resolvedLocation.longitude,
        faultProblem: faultProblem || null,
        tipAmount: toFiniteNumber(req.body?.tipAmount) || 0,
      },
    });
    if (idempotencyKey) {
      const existing = await findBookingByIdempotencyKey(idempotencyKey);
      if (existing) return sendScheduleReplay(res, existing);
      doc.idempotencyKey = idempotencyKey;
    }

    // ─── Booking + outbox in one transaction ──────────────────────────────
    const session = await mongoose.startSession();
    let prepared = null;
    try {
      session.startTransaction();
      prepared = await prepareScheduledBooking({
        doc,
        session,
        latitude: resolvedLocation.latitude,
        longitude: resolvedLocation.longitude,
      });
      const { booking } = prepared;
      await session.commitTransaction();

      // Broadcast ONLY after commit (inline fast path; outbox worker retries)
      const broadcastResult = await broadcastCreatedBooking(booking._id, req.io);

      const dispDate = schedule.scheduledAt
        ? schedule.scheduledAt.toLocaleString("en-IN", {
            day: "2-digit", month: "short", year: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: true,
          })
        : null;

      return res.status(201).json({
        success: true,
        message: schedule.bookingType === "schedule"
          ? `Booking placed for ${schedule.slotLabel || dispDate}. Awaiting technician confirmation.`
          : "Booking created and broadcasted successfully",
        result: {
          bookingId: booking._id,
          bookingType: schedule.bookingType === "schedule" ? "scheduled" : "instant",
          status: "pending",
          scheduledAt: booking.scheduledAt,
          scheduledDateLocal: booking.scheduledDateLocal,
          scheduledTimeLocal: booking.scheduledTimeLocal,
          timezone: booking.timezone,
          slotKey: booking.slotKey,
          slotLabel: booking.slotLabel,
          broadcastCount: broadcastResult.count ?? 0,
        },
      });
    } catch (txError) {
      await session.abortTransaction();
      if (prepared?.releaseCapacity) await prepared.releaseCapacity();
      const txMessage = String(txError?.message || "");
      const retryableConflict =
        txError?.code === 112 ||
        txError?.errorLabels?.includes("TransientTransactionError") ||
        /WriteConflict|TransientTransactionError/i.test(txMessage);
      if (idempotencyKey && (isDuplicateKeyError(txError) || retryableConflict)) {
        const existing = await findBookingByIdempotencyKeyWithRetry(idempotencyKey);
        if (existing) return sendScheduleReplay(res, existing);
        if (retryableConflict) {
          return res.status(409).json({
            success: false,
            message: "Booking creation is already in progress. Please retry.",
            reason: "duplicate_booking_request",
          });
        }
      }
      throw txError;
    } finally {
      session.endSession();
    }

  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};



/* ================= RESCHEDULE (UNASSIGNED SCHEDULED BOOKING) ================= */
export const rescheduleBooking = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const { scheduledDate, scheduledTime, reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking id", result: {} });
    }

    const booking = await ServiceBooking.findOne({
      _id: id,
      customerId: req.user.userId,
    });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    }

    if (booking.bookingType !== "schedule" || !booking.scheduledAt) {
      return res.status(400).json({
        success: false,
        message: "Only scheduled bookings can be rescheduled",
        result: {},
      });
    }

    if (booking.technicianId || !["pending", "broadcasted"].includes(normalizeBookingStatus(booking.status))) {
      return res.status(409).json({
        success: false,
        message: "This booking is already assigned or closed. Please cancel and rebook.",
        result: {},
      });
    }

    const now = new Date();
    const cutoffMs = RESCHEDULE_CUTOFF_MINUTES * 60 * 1000;
    if (booking.scheduledAt.getTime() - now.getTime() < cutoffMs) {
      return res.status(409).json({
        success: false,
        message: `Reschedules are closed within ${RESCHEDULE_CUTOFF_MINUTES} minutes of the appointment. Please cancel and rebook.`,
        result: {},
      });
    }

    const schedule = resolveScheduleInput(
      { bookingType: "scheduled", scheduledDate, scheduledTime },
      { now }
    );
    if (schedule.error) {
      return res.status(400).json({ success: false, message: schedule.error, result: {} });
    }

    if (schedule.scheduledAt.getTime() === booking.scheduledAt.getTime()) {
      return res.status(400).json({
        success: false,
        message: "New slot must be different from the current slot",
        result: {},
      });
    }

    if ((booking.rescheduleCount || 0) >= MAX_RESCHEDULES_PER_BOOKING) {
      return res.status(409).json({
        success: false,
        message: `This booking has reached the maximum of ${MAX_RESCHEDULES_PER_BOOKING} reschedules. Please cancel and rebook.`,
        code: "RESCHEDULE_LIMIT_REACHED",
        result: {},
      });
    }

    const oldHold = await getActiveHoldForBooking(booking._id);
    const newCapacity = await acquireSlotCapacity({
      slotKey: schedule.slotKey,
      serviceId: booking.serviceId,
      districtId: booking.districtId,
      cityZoneId: booking.cityZoneId,
      latitude: null,
      longitude: null,
    });
    if (!newCapacity.ok) {
      return res.status(newCapacity.code === "NO_ELIGIBLE_TECHNICIAN" ? 409 : 409).json({
        success: false,
        message: newCapacity.code === "NO_ELIGIBLE_TECHNICIAN"
          ? "No technician is available for the selected slot"
          : "The selected slot is full. Please choose another slot.",
        code: newCapacity.code,
        result: {},
      });
    }

    const oldScheduledAt = booking.scheduledAt;
    const newScheduledAt = schedule.scheduledAt;
    const autoCancelAt = computeAutoCancelAt("schedule", newScheduledAt, now);
    const dispatchEligibleAt = computeDispatchEligibleAt("schedule", newScheduledAt, now);
    const rescheduleCount = (booking.rescheduleCount || 0) + 1;
    let transactionCommitted = false;

    try {
      await session.withTransaction(async () => {
      const updated = await ServiceBooking.findOneAndUpdate(
        {
          _id: booking._id,
          customerId: req.user.userId,
          bookingType: "schedule",
          status: { $in: ["pending", "broadcasted", "SEARCHING"] },
          technicianId: null,
          scheduledAt: oldScheduledAt,
        },
        {
          $set: {
            status: "pending",
            scheduledAt: newScheduledAt,
            slotKey: schedule.slotKey,
            slotValue: schedule.slotValue,
            slotLabel: schedule.slotLabel,
            slotStartAt: schedule.slotStartAt,
            slotEndAt: schedule.slotEndAt,
            timezone: schedule.timezone,
            scheduledDateLocal: schedule.scheduledDateLocal,
            scheduledTimeLocal: schedule.scheduledTimeLocal,
            customerStatusLabel: "Awaiting technician",
            originalScheduledAt: booking.originalScheduledAt || oldScheduledAt,
            rescheduleStatus: "accepted",
            rescheduleRequestedAt: now,
            rescheduleRequestedBy: "customer",
            rescheduleReason: reason || null,
            rescheduleRespondBy: null,
            rescheduleCount,
            autoCancelAt,
            dispatchEligibleAt,
            broadcastedAt: null,
            broadcastStartedAt: now,
            assignmentStatus: "unassigned",
            lastRebroadcastAt: null,
            enforcementAlertAt: null,
            noShowAt: null,
            matchingLeaseUntil: null,
            matchingLeaseOwner: null,
            "remindersSent.h24": false,
            "remindersSent.h1": false,
            "remindersSent.min15": false,
            "remindersSent.enforceOTW": false,
            "remindersSent.escalate25": false,
            "remindersSent.escalate15": false,
            "remindersSent.escalate10": false,
          },
          $inc: { version: 1 },
        },
        { new: true, session }
      );

      if (!updated) {
        const error = new Error("Booking changed concurrently. Please refresh and retry.");
        error.statusCode = 409;
        throw error;
      }

      await JobBroadcast.updateMany(
        { bookingId: booking._id, status: { $in: ["sent", "expired", "rejected"] } },
        {
          $set: {
            status: "expired",
            expiredAt: now,
            expiredReason: "rescheduled",
            lastPushedAt: null,
            lastPushedVersion: null,
          },
        },
        { session }
      );

      await TechnicianBookingOffer.updateMany(
        { bookingId: booking._id, decision: "offered" },
        { $set: { decision: "superseded", respondedAt: now } },
        { session }
      );

      await DispatchOutbox.updateMany(
        { bookingId: booking._id, kind: "job_new", status: { $in: ["pending", "inflight"] } },
        {
          $set: {
            status: "done",
            completedAt: now,
            lastError: "superseded_by_reschedule",
          },
        },
        { session }
      );

      await writeAuditLog({
        actor: req.user.userId,
        actorRole: "Customer",
        action: "BOOKING_RESCHEDULED",
        targetType: "ServiceBooking",
        targetId: booking._id,
        before: { scheduledAt: oldScheduledAt },
        after: { scheduledAt: newScheduledAt, rescheduleCount },
        reason: reason || null,
        session,
      });

      await SlotHold.updateOne(
        { bookingId: booking._id, active: true },
        {
          $set: {
            slotKey: schedule.slotKey,
            slotStartAt: schedule.slotStartAt,
            slotEndAt: schedule.slotEndAt,
            capacityKeys: newCapacity.capacityKeys,
            expiresAt: autoCancelAt,
          },
        },
        { session }
      );
    });
      transactionCommitted = true;
    } finally {
      if (transactionCommitted) {
        if (oldHold?.capacityKeys?.length) {
          await releaseSlotCapacity(oldHold.capacityKeys, { confirmed: oldHold.status === "confirmed" });
        }
      } else {
        await releaseSlotCapacity(newCapacity.capacityKeys);
      }
    }

    const updatedBooking = await ServiceBooking.findById(booking._id);

    if (req.io) {
      const payload = {
        bookingId: updatedBooking._id,
        scheduledAt: updatedBooking.scheduledAt,
        scheduledDateLocal: updatedBooking.scheduledDateLocal,
        scheduledTimeLocal: updatedBooking.scheduledTimeLocal,
        slotKey: updatedBooking.slotKey,
        slotLabel: updatedBooking.slotLabel,
        timezone: updatedBooking.timezone,
      };
      req.io.to(`customer_${req.user.userId}`).emit("booking_rescheduled", payload);
      req.io.to("admin_dashboard").emit("booking_rescheduled", payload);
    }

    matchAndBroadcastBooking(updatedBooking._id, req.io).catch((err) =>
      console.error("Re-broadcast after reschedule failed:", err.message)
    );

    return res.status(200).json({
      success: true,
      message: "Booking rescheduled successfully",
      result: {
        bookingId: updatedBooking._id,
        scheduledAt: updatedBooking.scheduledAt,
        scheduledDateLocal: updatedBooking.scheduledDateLocal,
        scheduledTimeLocal: updatedBooking.scheduledTimeLocal,
        slotKey: updatedBooking.slotKey,
        slotLabel: updatedBooking.slotLabel,
        timezone: updatedBooking.timezone,
        rescheduleCount: updatedBooking.rescheduleCount,
      },
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("rescheduleBooking Error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      result: {},
    });
  } finally {
    session.endSession();
  }
};

/* ================= GET BOOKING SCHEDULE ================= */
export const getBookingSchedule = async (req, res) => {
  try {
    const { serviceId, addressId } = req.query;
    let availability = {
      enabled: false,
      reason: "service_required",
    };

    if (serviceId) {
      if (!mongoose.Types.ObjectId.isValid(serviceId)) {
        availability = { enabled: false, reason: "invalid_service_id" };
      } else {
        const service = await Service.findById(serviceId).select("isActive durationMinutes");
        if (!service || !service.isActive) {
          availability = { enabled: false, reason: "service_not_found" };
        } else {
          const latitude = toFiniteNumber(req.query.latitude ?? req.query.lat);
          const longitude = toFiniteNumber(req.query.longitude ?? req.query.lng ?? req.query.lon);
          let location = null;

          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            location = { latitude, longitude };
          } else if (addressId && req.user?.userId) {
            try {
              const resolved = await resolveUserLocation({
                locationType: "saved",
                addressId,
                userId: req.user.userId,
              });
              if (resolved?.success) {
                location = { latitude: resolved.latitude, longitude: resolved.longitude };
              }
            } catch {
              location = null;
            }
          }

          if (!location) {
            availability = { enabled: false, reason: "location_required" };
          } else {
            const zoneCheck = await resolveServiceZoneAvailability({
              service,
              latitude: location.latitude,
              longitude: location.longitude,
            });
            if (!zoneCheck.ok) {
              availability = {
                enabled: true,
                available: false,
                reason: zoneCheck.reason || "SERVICE_NOT_AVAILABLE",
                days: {},
              };
            } else {
              availability = await getSlotAvailability({
                serviceId,
                districtId: zoneCheck.districtId,
                cityZoneId: zoneCheck.zoneId,
                latitude: location.latitude,
                longitude: location.longitude,
              }) || { enabled: false, reason: "disabled" };
            }
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Booking schedule options",
      result: getBookingSchedulePayload(new Date(), undefined, availability),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};


/* =====================================================
   GET BOOKINGS (ROLE BASED)
===================================================== */

// Customers must NEVER see the platform margin or technician earnings.
// Strip commission/technician-amount fields from a booking before it goes
// to a Customer (technicians & admins legitimately need them).
const stripSensitiveFinancials = (booking) => {
  const o = booking.toObject ? booking.toObject() : { ...booking };
  if (o.financialSnapshot) {
    delete o.financialSnapshot.commissionAmountPaise;
    delete o.financialSnapshot.commissionPercentage;
    delete o.financialSnapshot.commissionRuleSource;
    delete o.financialSnapshot.commissionRuleId;
    delete o.financialSnapshot.commissionOverridden;
    const totalPaise = o.financialSnapshot.totalAmountPaise;
    if (Number.isFinite(totalPaise)) {
      o.totalAmount = paiseToRupees(totalPaise);
      o.totalAmountPaise = totalPaise;
    }
    const basePaise = o.financialSnapshot.baseAmountPaise;
    if (Number.isFinite(basePaise)) {
      o.serviceAmount = paiseToRupees(basePaise);
      o.discountAmount = paiseToRupees(o.financialSnapshot.discountAmountPaise || 0);
    }
  }
  delete o.technicianAmount;
  delete o.technicianAmountPaise;
  delete o.commissionAmount;
  delete o.commissionPercentage;
  delete o.commissionOverridden;
  return o;
};

export const getBookings = async (req, res) => {
  try {
    let filter = {};

    if (req.user.role === "Customer") {
      if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
        return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
      }
      filter.customerId = req.user.userId;
    }

    if (req.user.role === "Technician") {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
        return res.status(401).json({ success: false, message: "Invalid token profile", result: {} });
      }
      filter.technicianId = technicianProfileId;
    }

    // For Admin/Owner: no filter, shows all bookings (intended — admins see all).
    // For Customer/Technician: filtered by their ID (data isolation).

    const bookings = await ServiceBooking.find(filter)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType serviceCost")
      .populate({
        path: "technicianId",
        select: "userId profileImage workStatus",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber"
        }
      })
      .sort({ createdAt: -1 });

    const result =
      req.user.role === "Customer"
        ? bookings.map(stripSensitiveFinancials)
        : bookings;

    return res.status(200).json({
      success: true,
      message: "Bookings fetched successfully",
      result,
    });
  } catch (error) {
    console.error("getBookings:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* =====================================================
   GET BOOKING FOR (CUSTOMER)
===================================================== */

export const getCustomerBookings = async (req, res) => {
  // 📦 STABLE RESPONSE CONTRACT — every path returns the exact same shape:
  //   { success: bool, message: string, result: array, meta: {totalCount, page, limit, filtersApplied} }
  // `result` is ALWAYS an array (empty on error) — never {} / {error} / null,
  // so client model parsing can never break.
  const envelope = (success, message, bookings = [], meta = {}) =>
    res.status(200).json({
      success,
      message,
      result: bookings,
      meta: {
        totalCount: meta.totalCount ?? 0,
        page: meta.page ?? 1,
        limit: meta.limit ?? 20,
        filtersApplied: meta.filtersApplied ?? {
          filter: "all",
          status: "all",
          paymentStatus: "all",
          bookingType: "all",
          search: null,
        },
      },
    });

  try {
    if (req.user?.role !== "Customer") {
      return envelope(false, "Customer access only");
    }
    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return envelope(false, "Invalid token user");
    }

    const { status, paymentStatus, bookingType, search, page, limit, filter: filterParam } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const filtersApplied = {
      filter: filterParam || "all",
      status: status || "all",
      paymentStatus: paymentStatus || "all",
      bookingType: bookingType || "all",
      search: search || null,
    };
    const filter = { customerId: req.user.userId };

    // 1️⃣ Filter by Booking Status ("completed", "pending", "accepted", "in_progress", "cancelled", "active", "expired")
    if (status && typeof status === "string" && status.trim() !== "") {
      const trimmedStatus = status.trim().toLowerCase();
      if (trimmedStatus === "active") {
        filter.status = { $in: ["pending", "accepted", "on_the_way", "reached", "in_progress", "broadcasted"] };
      } else {
        filter.status = trimmedStatus;
      }
    }

    // 2️⃣ Filter by Payment Status ("paid", "unpaid", "pending", "refunded")
    if (paymentStatus && typeof paymentStatus === "string" && paymentStatus.trim() !== "") {
      const pStatus = paymentStatus.trim().toLowerCase();
      if (pStatus === "unpaid") {
        filter.paymentStatus = "pending";
      } else {
        filter.paymentStatus = pStatus;
      }
    }

    // 3️⃣ Filter by Booking Type ("instant", "schedule", "scheduled")
    if (bookingType && typeof bookingType === "string" && bookingType.trim() !== "") {
      const bType = bookingType.trim().toLowerCase();
      filter.bookingType = bType === "scheduled" ? "schedule" : bType;
    }

    // 3️⃣.5️⃣ Filter Tabs — friendly one-param filters for the "My Bookings" UI.
    // Takes precedence over status/paymentStatus above. Tab → query mapping:
    //   all              → no status filter
    //   completed_unpaid → status=completed + paymentStatus=pending
    //   paid             → paymentStatus=paid
    //   accepted         → accepted/on_the_way/reached/in_progress
    //   broadcasting     → pending/broadcasted (no tech yet)
    //   expired          → status=expired
    //   active           → any in-flight status + completed-but-unpaid
    const FILTER_TABS = {
      all: {},
      completed_unpaid: { status: "completed", paymentStatus: "pending" },
      paid: { paymentStatus: "paid" },
      accepted: {
        status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
      },
      broadcasting: {
        status: { $in: ["pending", "broadcasted"] },
      },
      expired: { status: "expired" },
      active: {
        $or: [
          { status: { $in: ["pending", "broadcasted", "accepted", "on_the_way", "reached", "in_progress"] } },
          { status: "completed", paymentStatus: "pending" },
        ],
      },
    };

    if (filterParam && typeof filterParam === "string" && FILTER_TABS[filterParam.trim().toLowerCase()]) {
      const tab = FILTER_TABS[filterParam.trim().toLowerCase()];
      delete filter.status;
      delete filter.paymentStatus;
      if (tab.$or) {
        filter.$or = filter.$or ? [...filter.$or, ...tab.$or] : [...tab.$or];
      } else {
        Object.assign(filter, tab);
      }
    }

    // 4️⃣ Search Query (Searches address, fault notes, payment order ID, or booking ID).
    // B-17 follow-up: literal-escaped (user text is not a regex pattern).
    if (search && typeof search === "string" && search.trim().length >= 2) {
      const searchTerm = search.trim();
      const searchRegex = containsRegex(searchTerm);
      const searchClauses = [
        { address: searchRegex },
        { faultProblem: searchRegex },
        { paymentOrderId: searchRegex },
      ];
      if (mongoose.Types.ObjectId.isValid(searchTerm)) {
        searchClauses.push({ _id: new mongoose.Types.ObjectId(searchTerm) });
      }
      // Merge with any $or already applied (e.g. the "active" tab)
      filter.$or = filter.$or ? [...filter.$or, ...searchClauses] : searchClauses;
    }

    // 5️⃣ Query Execution & Pagination
    const bookings = await ServiceBooking.find(filter)
      .populate("serviceId", "serviceName serviceType serviceCost serviceImages description discountedPrice")
      .populate({
        path: "technicianId",
        select: "userId profileImage workStatus ratingSummary",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber"
        }
      })
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    const totalCount = await ServiceBooking.countDocuments(filter);

    // Never expose platform commission / technician earnings to the customer.
    const safeBookings = bookings.map(stripSensitiveFinancials);

    return envelope(true, totalCount > 0 ? "Customer booking history" : "No bookings found", safeBookings, {
      totalCount,
      page: pageNum,
      limit: limitNum,
      filtersApplied,
    });
  } catch (err) {
    console.error("getCustomerBookings Error:", err);
    // Never break the client — same envelope, empty result, message only.
    return envelope(false, "Failed to fetch bookings. Please try again.");
  }
};

/* =====================================================
   GET JOB FOR (TECHNICIAN)
===================================================== */

export const getTechnicianJobHistory = async (req, res) => {
  try {
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Access denied",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const technicianId = req.technician._id;
    const userId = req.technician.userId;
    // Check technician activation status
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      return res.status(200).json({
        success: true,
        message: activation.message,
        result: [],
      });
    }

    const jobs = await ServiceBooking.find({
      technicianId: { $in: [technicianId, userId] },
      status: { $in: ["completed", "cancelled"] },
    })
      .populate("customerId", "fname lname mobileNumber email")
      .populate({
        path: "serviceId",
        populate: { path: "categoryId" }
      })
      .sort({ updatedAt: -1 });

    // Remove baseAmount and add technicianAmount from service
    const filteredJobs = jobs.map(job => {
      const jobData = job.toObject ? job.toObject() : job;
      const { baseAmount, ...jobWithoutBaseAmount } = jobData;
      // Ensure technicianAmount is from service
      return {
        ...jobWithoutBaseAmount,
        technicianAmount: jobData.serviceId?.technicianAmount || jobData.technicianAmount || 0,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Job history fetched",
      result: filteredJobs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      result: { error: err.message },
    });
  }
};


/* =====================================================
   GET CURRENT JOBS (TECHNICIAN & OWNER)
===================================================== */
export const getTechnicianCurrentJobs = async (req, res) => {
  try {
    const userRole = req.user?.role;

    // Validate role access
    if (userRole !== "Technician" && userRole !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Technician or Owner access only.",
        result: {},
      });
    }


    const query = {};

    // For Technician, we get profileId from token. For Owner, we return all current jobs.
    if (userRole === "Technician") {
      // Technician: Only their own jobs
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. Technician profile not found.",
          result: {},
        });
      }

      // Check technician activation status
      const activation = await checkTechnicianActivation(technicianProfileId);
      if (!activation.isActive) {
        return res.status(200).json({
          success: true,
          message: activation.message,
          result: [],
        });
      }

      query.technicianId = technicianProfileId;
    }
    // If role is Owner: no additional filter, get all current jobs

    const jobs = await ServiceBooking.find({
      ...query,
      status: { $in: ["accepted", "ACCEPTED", "on_the_way", "reached", "in_progress"] },
    })
      .populate({
        path: "customerId",
        select: "fname lname mobileNumber email",
      })
      .populate({
        path: "technicianId",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber email",
        },
        select: "userId profileImage locality workStatus",
      })
      .populate({
        path: "addressId",
        select: "name phone addressLine city state pincode latitude longitude",
      })
      .populate({
        path: "serviceId",
        populate: { path: "categoryId" }
      })
      .sort({ createdAt: -1 });

    // Format response for better readability
    const formattedJobs = jobs.map((job) => {
      const jobObj = job.toObject();

      // Format customer details
      const customer = jobObj.customerId
        ? {
          fname: jobObj.customerId.fname || "",
          lname: jobObj.customerId.lname || "",
          mobileNumber: jobObj.customerId.mobileNumber || "",
          email: jobObj.customerId.email || "",
        }
        : null;

      // Format technician details
      const technician = jobObj.technicianId
        ? {
          fname: jobObj.technicianId.userId?.fname || "",
          lname: jobObj.technicianId.userId?.lname || "",
          mobileNumber: jobObj.technicianId.userId?.mobileNumber || "",
          email: jobObj.technicianId.userId?.email || "",
          profileImage: jobObj.technicianId.profileImage || null,
          locality: jobObj.technicianId.locality || "",
          workStatus: jobObj.technicianId.workStatus || "",
        }
        : null;

      // Format service details
      const service = jobObj.serviceId || null;

      // Format address details
      let address = null;
      if (jobObj.addressId) {
        address = {
          name: jobObj.addressId.name || "",
          phone: jobObj.addressId.phone || "",
          addressLine: jobObj.addressId.addressLine || "",
          city: jobObj.addressId.city || "",
          state: jobObj.addressId.state || "",
          pincode: jobObj.addressId.pincode || "",
          //sk
          latitude: jobObj.addressId.latitude,
          longitude: jobObj.addressId.longitude,
        };
      } else if (jobObj.addressSnapshot) {
        address = {
          name: jobObj.addressSnapshot.name || "",
          phone: jobObj.addressSnapshot.phone || "",
          addressLine: jobObj.addressSnapshot.addressLine || "",
          city: jobObj.addressSnapshot.city || "",
          state: jobObj.addressSnapshot.state || "",
          pincode: jobObj.addressSnapshot.pincode || "",
          latitude: jobObj.addressSnapshot.latitude,
          longitude: jobObj.addressSnapshot.longitude,
        };
      }

      // Fallback to GeoJSON if needed
      if (address && (!address.latitude || !address.longitude) && jobObj.location?.coordinates) {
        address.longitude = jobObj.location.coordinates[0];
        address.latitude = jobObj.location.coordinates[1];
      }

      const responseData = {
        jobId: jobObj._id,
        status: normalizeBookingStatus(jobObj.status),
        customer,
        technician,
        service,
        address,
        scheduledAt: jobObj.scheduledAt,
        createdAt: jobObj.createdAt,
        acceptedAt: jobObj.assignedAt,
        paymentStatus: jobObj.paymentStatus,
      };

      // Only include baseAmount for Owner role
      if (userRole !== "Technician") {
        responseData.baseAmount = jobObj.baseAmount;
      } else {
        responseData.technicianAmount = jobObj.serviceId?.technicianAmount || jobObj.technicianAmount || 0;
      }

      return responseData;
    });

    return res.status(200).json({
      success: true,
      message: `Active jobs fetched for ${userRole}`,
      result: formattedJobs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      result: { error: err.message },
    });
  }
};


/* =====================================================
   GET ALL ACCEPTED JOBS (TECHNICIAN & OWNER)
   Status: accepted → in_progress, newest first.
   Technician → own jobs. Owner/Admin → all jobs (optional technicianId).
===================================================== */
export const getAllAcceptedJobs = async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (userRole !== "Technician" && userRole !== "Owner" && userRole !== "Admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Technician/Owner/Admin access only.",
        result: {},
      });
    }

    const query = { status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] } };

    if (userRole === "Technician") {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. Technician profile not found.",
          result: {},
        });
      }
      query.technicianId = technicianProfileId;
    } else if (req.query.technicianId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.technicianId)) {
        return res.status(400).json({ success: false, message: "Invalid technician ID", result: {} });
      }
      query.technicianId = req.query.technicianId;
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));

    const [jobs, totalCount] = await Promise.all([
      ServiceBooking.find(query)
        .populate({ path: "customerId", select: "fname lname mobileNumber email" })
        .populate({
          path: "technicianId",
          populate: { path: "userId", select: "fname lname mobileNumber email" },
          select: "userId profileImage locality workStatus",
        })
        .populate({ path: "serviceId", populate: { path: "categoryId" } })
        .populate({ path: "addressId", select: "name phone addressLine city state pincode latitude longitude" })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      ServiceBooking.countDocuments(query),
    ]);

    const formattedJobs = jobs.map((job) => {
      const jobObj = job.toObject();
      const customer = jobObj.customerId
        ? { fname: jobObj.customerId.fname || "", lname: jobObj.customerId.lname || "", mobileNumber: jobObj.customerId.mobileNumber || "", email: jobObj.customerId.email || "" }
        : null;
      const technician = jobObj.technicianId
        ? { fname: jobObj.technicianId.userId?.fname || "", lname: jobObj.technicianId.userId?.lname || "", mobileNumber: jobObj.technicianId.userId?.mobileNumber || "", email: jobObj.technicianId.userId?.email || "", profileImage: jobObj.technicianId.profileImage || null, locality: jobObj.technicianId.locality || "" }
        : null;
      const address = jobObj.addressId
        ? { name: jobObj.addressId.name || "", phone: jobObj.addressId.phone || "", addressLine: jobObj.addressId.addressLine || "", city: jobObj.addressId.city || "", state: jobObj.addressId.state || "", pincode: jobObj.addressId.pincode || "", latitude: jobObj.addressId.latitude, longitude: jobObj.addressId.longitude }
        : (jobObj.addressSnapshot || null);

      const responseData = {
        jobId: jobObj._id,
        bookingType: jobObj.bookingType,
        status: normalizeBookingStatus(jobObj.status),
        customer,
        technician,
        service: jobObj.serviceId || null,
        address,
        scheduledAt: jobObj.scheduledAt,
        createdAt: jobObj.createdAt,
        acceptedAt: jobObj.assignedAt,
        paymentStatus: jobObj.paymentStatus,
      };
      if (userRole !== "Technician") {
        responseData.baseAmount = jobObj.baseAmount;
        responseData.technicianAmount = jobObj.serviceId?.technicianAmount || jobObj.technicianAmount || 0;
      }
      return responseData;
    });

    return res.status(200).json({
      success: true,
      message: formattedJobs.length > 0 ? "Accepted jobs fetched" : "No accepted jobs found",
      result: formattedJobs,
      pagination: { page, limit, totalCount },
    });
  } catch (err) {
    console.error("getAllAcceptedJobs Error:", err);
    return res.status(500).json({ success: false, message: err.message, result: { error: err.message } });
  }
};

/* =====================================================
   GET ACCEPTED SCHEDULED JOBS (TECHNICIAN & OWNER)
   Status: accepted → in_progress, bookingType: schedule.
   Technician → own jobs. Owner/Admin → all jobs (optional technicianId).
===================================================== */
export const getAcceptedScheduledJobs = async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (userRole !== "Technician" && userRole !== "Owner" && userRole !== "Admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Technician/Owner/Admin access only.",
        result: {},
      });
    }

    const query = {
      bookingType: "schedule",
      status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
    };

    if (userRole === "Technician") {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. Technician profile not found.",
          result: {},
        });
      }
      query.technicianId = technicianProfileId;
    } else if (req.query.technicianId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.technicianId)) {
        return res.status(400).json({ success: false, message: "Invalid technician ID", result: {} });
      }
      query.technicianId = req.query.technicianId;
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));

    const [jobs, totalCount] = await Promise.all([
      ServiceBooking.find(query)
        .populate({ path: "customerId", select: "fname lname mobileNumber email" })
        .populate({
          path: "technicianId",
          populate: { path: "userId", select: "fname lname mobileNumber email" },
          select: "userId profileImage locality workStatus",
        })
        .populate({ path: "serviceId", populate: { path: "categoryId" } })
        .populate({ path: "addressId", select: "name phone addressLine city state pincode latitude longitude" })
        .sort({ scheduledAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      ServiceBooking.countDocuments(query),
    ]);

    const formattedJobs = jobs.map((job) => {
      const jobObj = job.toObject();
      const customer = jobObj.customerId
        ? { fname: jobObj.customerId.fname || "", lname: jobObj.customerId.lname || "", mobileNumber: jobObj.customerId.mobileNumber || "", email: jobObj.customerId.email || "" }
        : null;
      const technician = jobObj.technicianId
        ? { fname: jobObj.technicianId.userId?.fname || "", lname: jobObj.technicianId.userId?.lname || "", mobileNumber: jobObj.technicianId.userId?.mobileNumber || "", email: jobObj.technicianId.userId?.email || "", profileImage: jobObj.technicianId.profileImage || null, locality: jobObj.technicianId.locality || "" }
        : null;
      const address = jobObj.addressId
        ? { name: jobObj.addressId.name || "", phone: jobObj.addressId.phone || "", addressLine: jobObj.addressId.addressLine || "", city: jobObj.addressId.city || "", state: jobObj.addressId.state || "", pincode: jobObj.addressId.pincode || "", latitude: jobObj.addressId.latitude, longitude: jobObj.addressId.longitude }
        : (jobObj.addressSnapshot || null);

      const responseData = {
        jobId: jobObj._id,
        bookingType: jobObj.bookingType,
        status: normalizeBookingStatus(jobObj.status),
        customer,
        technician,
        service: jobObj.serviceId || null,
        address,
        scheduledAt: jobObj.scheduledAt,
        createdAt: jobObj.createdAt,
        acceptedAt: jobObj.assignedAt,
        paymentStatus: jobObj.paymentStatus,
      };
      if (userRole !== "Technician") {
        responseData.baseAmount = jobObj.baseAmount;
        responseData.technicianAmount = jobObj.serviceId?.technicianAmount || jobObj.technicianAmount || 0;
      }
      return responseData;
    });

    return res.status(200).json({
      success: true,
      message: formattedJobs.length > 0 ? "Accepted scheduled jobs fetched" : "No accepted scheduled jobs found",
      result: formattedJobs,
      pagination: { page, limit, totalCount },
    });
  } catch (err) {
    console.error("getAcceptedScheduledJobs Error:", err);
    return res.status(500).json({ success: false, message: err.message, result: { error: err.message } });
  }
};

/* =====================================================
   UPDATE BOOKING STATUS (TECHNICIAN)
===================================================== */
export const updateBookingStatus = async (req, res) => {
  try {
    const userRole = req.user?.role;

    const bookingId = req.params.id;
    const { status } = req.body;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID format",
        result: {},
      });
    }

    const allowedStatus = [
      "on_the_way",
      "reached",
      "in_progress",
      "completed",
    ];

    if (!bookingId || !allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    let booking = await ServiceBooking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
        result: {},
      });
    }
    if (userRole !== "Technician") {
      return res.status(403).json({ success: false, message: "Only technician can update status", result: {} });
    }
    const accessError = completionAccessError(booking, technicianProfileId);
    if (accessError) {
      return res.status(accessError.statusCode || 403).json({ success: false, message: accessError.message, result: {} });
    }
    // Idempotent completion — checked BEFORE the transition table so a
    // post-payment "complete" call returns 200 instead of being told to
    // request another OTP (completed → completed is not a transition).
    if (status === "completed" && normalizeBookingStatus(booking.status) === "completed") {
      const completed = booking.toObject ? booking.toObject() : booking;
      return res.status(200).json({
        success: true,
        message: "Booking already completed",
        result: { ...completed, requiresCompletionOtp: false },
      });
    }
    // 🔒 Explicit transition table — the booking must be in a state that
    // allows moving to `status` (canonical state machine only).
    if (!canTransition(booking.status, status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot move booking from "${booking.status}" to "${status}"`,
        result: {},
      });
    }
    // 🔒 Completion requires customer OTP verification. The direct
    // completed transition is closed BEFORE any state write — use POST
    // /api/technician/booking/:id/verify-completion-otp instead.
    if (status === "completed") {
      return res.status(409).json({
        success: false,
        message: "Service completion requires customer OTP verification. Request an OTP, then verify it.",
        result: { code: "COMPLETION_OTP_REQUIRED", requiresCompletionOtp: true },
      });
    }
    // Check technician approval status
    const technician = await TechnicianProfile.findById(technicianProfileId);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }
    if (!technician.profileComplete) {
      return res.status(403).json({
        success: false,
        message: "Please complete your profile first",
        result: { profileComplete: false },
      });
    }

    // Check technician activation status (KYC + Bank + Training)
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      return res.status(403).json({
        success: false,
        message: activation.message,
        result: {},
      });
    }

    // Check workStatus
    if (technician.workStatus !== "approved") {
      return res.status(403).json({
        success: false,
        message: "Your account must be approved by owner before working. Status: " + technician.workStatus,
        result: { workStatus: technician.workStatus },
      });
    }
    if (booking.bookingType === "schedule") {
      const slot = booking.slotKey
        ? { slotStartAt: booking.slotStartAt }
        : getSlotForTime(booking.scheduledAt);
      const slotStartAt = slot?.slotStartAt ? new Date(slot.slotStartAt) : new Date(booking.scheduledAt);
      const now = new Date();
      if (status === "on_the_way" && now.getTime() < slotStartAt.getTime() - 35 * 60 * 1000) {
        return res.status(409).json({
          success: false,
          message: "You can start travel at most 35 minutes before the slot begins.",
          code: "TOO_EARLY_FOR_SLOT",
          result: { slotStartAt },
        });
      }
      if (status === "in_progress" && now.getTime() < slotStartAt.getTime()) {
        return res.status(409).json({
          success: false,
          message: "You cannot start the service before the slot begins.",
          code: "SLOT_NOT_STARTED",
          result: { slotStartAt },
        });
      }
    }

    // 🔒 Optimistic concurrency: bump version atomically and key the update on
    // the version we loaded. A concurrent status write changes the version and
    // makes this a no-op (modifiedCount 0) instead of silently overwriting a
    // newer state. The caller must reload and retry.
    // Legacy documents created before the `version` field existed have no
    // version — we match those via $exists:false so the update still works
    // (best-effort; fully safe only for versioned documents).
    const statusSet = { status };
    if (status === "on_the_way" || status === "completed") {
      statusSet.autoCancelAt = null; // Disable auto-cancel once technician starts moving or completes
    }
    if (status === "on_the_way") statusSet.onTheWayAt = new Date();
    if (status === "reached") statusSet.reachedAt = new Date();
    if (status === "in_progress") statusSet.inProgressAt = new Date();
    if (status === "completed") {
      statusSet.completedAt = new Date();
      statusSet.assignmentStatus = "released";
    }
    const versionPredicate = booking.version == null
      ? { _id: booking._id, version: { $exists: false } }
      : { _id: booking._id, version: booking.version };
    const statusUpdate = await ServiceBooking.updateOne(versionPredicate, {
      $set: statusSet,
      $inc: { version: 1 },
    });
    if (statusUpdate.modifiedCount !== 1) {
      return res.status(409).json({
        success: false,
        message: "Booking was updated by another request. Please reload and retry.",
        result: {},
      });
    }
    // NOTE: the `completed` transition is closed above (409 → verify-completion-otp).
    // Post-commit side effects for verified completion live in
    // fireBookingCompletedSideEffects and are invoked only from
    // verifyCompletionOtp below — never from this generic path.

    // Re-fetch booking with service details to include technicianAmount
    const updatedBooking = await ServiceBooking.findById(booking._id)
      .populate("serviceId", "serviceName serviceType technicianAmount");

    // Remove baseAmount and include technicianAmount from service
    const bookingData = updatedBooking.toObject ? updatedBooking.toObject() : updatedBooking;
    const { baseAmount, ...bookingWithoutBaseAmount } = bookingData;
    bookingWithoutBaseAmount.technicianAmount = bookingData.serviceId?.technicianAmount || bookingData.technicianAmount || 0;

    return res.status(200).json({
      success: true,
      message: "Status updated",
      result: bookingWithoutBaseAmount,
    });
  } catch (error) {
    console.error("updateBookingStatus:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* =====================================================
   SERVICE COMPLETION OTP (TECHNICIAN + CUSTOMER)
   Customer-confirmed completion — Checkpoint C.
   Responses never contain OTP, hash, pepper, phone, or provider payload.
===================================================== */
const completionOtpErrorResult = (error) => ({
  ...(error.code ? { code: error.code } : {}),
  ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  ...(error.details && typeof error.details === "object" ? error.details : {}),
});

export const requestCompletionOtp = async (req, res) => {
  try {
    const result = await requestCompletionOtpService({
      bookingId: req.params.id,
      technicianProfileId: req.user?.technicianProfileId,
      io: req.io,
    });
    return res.status(200).json({ success: true, message: "Completion verification requested.", result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      result: completionOtpErrorResult(error),
    });
  }
};

export const resendCompletionOtp = async (req, res) => {
  try {
    const result = await resendCompletionOtpService({
      bookingId: req.params.id,
      technicianProfileId: req.user?.technicianProfileId,
      io: req.io,
    });
    return res.status(200).json({ success: true, message: "Completion OTP resent.", result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      result: completionOtpErrorResult(error),
    });
  }
};

export const verifyCompletionOtp = async (req, res) => {
  try {
    const { booking, generation } = await verifyCompletionOtpService({
      bookingId: req.params.id,
      technicianProfileId: req.user?.technicianProfileId,
      otp: req.body?.otp,
    });
    // Existing post-commit side effects (settlement attempt + notifications),
    // exactly once — the transaction above already flipped the booking.
    await fireBookingCompletedSideEffects(booking, req.user?.technicianProfileId, req.io);
    await releaseScheduledSlot({ bookingId: booking._id, reason: "completed" }).catch((releaseErr) => {
      console.error("completion slot release failed:", releaseErr.message);
    });
    const updatedBooking = await ServiceBooking.findById(booking._id)
      .populate("serviceId", "serviceName serviceType technicianAmount");
    return res.status(200).json({
      success: true,
      message: "Service completion verified.",
      result: {
        bookingId: String(booking._id),
        verificationStatus: "verified",
        requiresCompletionOtp: false,
        generation,
        booking: updatedBooking,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      result: completionOtpErrorResult(error),
    });
  }
};

export const getCompletionStatus = async (req, res) => {
  try {
    const role = req.user?.role;
    const result = await getCompletionStatusService({
      bookingId: req.params.id,
      technicianProfileId: role === "Technician" ? req.user?.technicianProfileId : null,
      customerId: role === "Customer" ? req.user?.userId : null,
      isAdmin: role === "Admin" || role === "Owner",
    });
    return res.status(200).json({ success: true, message: "Completion status.", result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, result: {} });
  }
};

/* =====================================================
   UPLOAD WORK IMAGES (TECHNICIAN)
===================================================== */
export const uploadWorkImages = async (req, res) => {
  try {
    if (req.user?.role !== "Technician") {
      return res.status(403).json({ success: false, message: "Technician access only", result: {} });
    }

    const bookingId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format", result: {} });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ success: false, message: "Work images are required", result: {} });
    }

    const booking = await ServiceBooking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    }

    const accessError = completionAccessError(booking, technicianProfileId);
    if (accessError) {
      return res.status(accessError.statusCode || 403).json({ success: false, message: accessError.message, result: {} });
    }

    if (booking.status === "completed") {
      return res.status(400).json({ success: false, message: "Completed booking cannot be updated", result: {} });
    }

    const nextImages = booking.workImages ? { ...booking.workImages } : { beforeImage: null, afterImage: null };
    if (req.files.beforeImage?.[0]?.path) {
      nextImages.beforeImage = req.files.beforeImage[0].path;
    }
    if (req.files.afterImage?.[0]?.path) {
      nextImages.afterImage = req.files.afterImage[0].path;
    }

    if (!nextImages.beforeImage && !nextImages.afterImage) {
      return res.status(400).json({ success: false, message: "Work images are required", result: {} });
    }

    booking.workImages = nextImages;
    await booking.save();

    // Re-fetch booking with service details to include technicianAmount
    const updatedBooking = await ServiceBooking.findById(booking._id)
      .populate("serviceId", "serviceName serviceType technicianAmount");

    // Remove baseAmount and include technicianAmount from service
    const bookingData = updatedBooking.toObject ? updatedBooking.toObject() : updatedBooking;
    const { baseAmount, ...bookingWithoutBaseAmount } = bookingData;
    bookingWithoutBaseAmount.technicianAmount = bookingData.serviceId?.technicianAmount || bookingData.technicianAmount || 0;

    return res.status(200).json({
      success: true,
      message: "Work images uploaded successfully",
      result: bookingWithoutBaseAmount,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};


/* =====================================================
   CUSTOMER NO-SHOW (TECHNICIAN REPORT + CUSTOMER RESPONSE)
===================================================== */
const confirmCustomerNoShow = async ({ booking, now = new Date() }) => {
  const techAmountPaise = Number(booking.financialSnapshot?.technicianAmountPaise) || 0;
  const totalPaise = Number(booking.financialSnapshot?.totalAmountPaise) || 0;
  const rawCompensation = Math.round(
    techAmountPaise * (CUSTOMER_NO_SHOW_COMPENSATION_PERCENT / 100)
  );
  const compensationPaise = CUSTOMER_NO_SHOW_COMPENSATION_ENABLED
    ? Math.min(
        totalPaise > 0 ? totalPaise : rawCompensation,
        Math.max(CUSTOMER_NO_SHOW_MIN_COMPENSATION_PAISE, rawCompensation)
      )
    : 0;

  const updated = await ServiceBooking.findOneAndUpdate(
    {
      _id: booking._id,
      customerNoShowStatus: "awaiting_customer",
    },
    {
      $set: {
        customerNoShowStatus: "confirmed",
        customerNoShowConfirmedAt: now,
        customerNoShowCompensationPaise: compensationPaise,
        customerNoShowCompensationStatus: compensationPaise > 0 ? "recorded" : "none",
      },
      $inc: { version: 1 },
    },
    { new: true }
  );

  if (updated?.technicianId) {
    await TechnicianProfile.updateOne(
      { _id: updated.technicianId },
      { $inc: { customerNoShowConfirmedCount: 1 } }
    );
  }
  return updated;
};

export const reportCustomerNoShow = async (req, res) => {
  try {
    if (req.user?.role !== "Technician") {
      return res.status(403).json({ success: false, message: "Technician access only", result: {} });
    }
    const { id } = req.params;
    const technicianProfileId = req.user?.technicianProfileId;
    const callLogId = typeof req.body?.callLogId === "string" ? req.body.callLogId.trim() : "";
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking id", result: {} });
    }
    if (!callLogId) {
      return res.status(400).json({
        success: false,
        code: "CALL_LOG_REQUIRED",
        message: "A system-logged masked call attempt is required before reporting a customer no-show.",
        result: {},
      });
    }

    const booking = await ServiceBooking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    if (String(booking.technicianId) !== String(technicianProfileId)) {
      return res.status(403).json({ success: false, message: "Not your booking", result: {} });
    }
    if (!["accepted", "on_the_way", "reached"].includes(normalizeBookingStatus(booking.status))) {
      return res.status(409).json({ success: false, message: "No-show can only be reported after reaching the location.", result: {} });
    }
    if (!booking.reachedAt) {
      return res.status(409).json({ success: false, message: "Mark the booking as reached before reporting a no-show.", result: {} });
    }
    if (booking.customerNoShowStatus === "awaiting_customer" || booking.customerNoShowStatus === "confirmed") {
      return res.status(409).json({ success: false, message: "A no-show claim is already open for this booking.", result: {} });
    }

    let callLog;
    try {
      callLog = await getCallLogForNoShow({
        callLogId,
        bookingId: booking._id,
        technicianId: technicianProfileId,
      });
    } catch (callError) {
      return res.status(callError.statusCode || 400).json({
        success: false,
        code: callError.code || "CALL_LOG_INVALID",
        message: callError.message,
        result: {},
      });
    }
    if (booking.reachedAt && new Date(callLog.createdAt).getTime() < new Date(booking.reachedAt).getTime() - 60000) {
      return res.status(400).json({
        success: false,
        code: "CALL_LOG_BEFORE_REACHED",
        message: "The call attempt must be made after you mark the booking as reached.",
        result: {},
      });
    }

    const now = new Date();
    const waitedMinutes = (now.getTime() - new Date(booking.reachedAt).getTime()) / 60000;
    if (waitedMinutes < CUSTOMER_NO_SHOW_WAIT_MINUTES) {
      return res.status(409).json({
        success: false,
        code: "NO_SHOW_WAIT_NOT_MET",
        message: `Wait at least ${CUSTOMER_NO_SHOW_WAIT_MINUTES} minutes after reaching the location.`,
        result: { waitedMinutes: Math.floor(waitedMinutes) },
      });
    }

    const technician = await TechnicianProfile.findById(technicianProfileId).select("location");
    const distance = technician?.location?.coordinates && booking.location?.coordinates
      ? haversineMeters(
          { latitude: technician.location.coordinates[1], longitude: technician.location.coordinates[0] },
          { latitude: booking.location.coordinates[1], longitude: booking.location.coordinates[0] }
        )
      : null;
    if (distance == null || distance > CUSTOMER_NO_SHOW_GEOFENCE_METERS) {
      return res.status(409).json({
        success: false,
        code: "NO_SHOW_GEOFENCE_FAILED",
        message: `You must be within ${CUSTOMER_NO_SHOW_GEOFENCE_METERS}m of the customer location to report a no-show.`,
        result: { distanceMeters: distance },
      });
    }

    const responseDeadline = new Date(now.getTime() + CUSTOMER_NO_SHOW_RESPONSE_MINUTES * 60 * 1000);
    const updated = await ServiceBooking.findOneAndUpdate(
      {
        _id: id,
        technicianId: technicianProfileId,
        customerNoShowStatus: { $in: ["none", "rejected"] },
      },
      {
        $set: {
          customerNoShowStatus: "awaiting_customer",
          customerNoShowReportedAt: now,
          customerNoShowResponseDeadline: responseDeadline,
        },
        $push: {
          customerNoShowCallAttempts: {
            callLogId: String(callLog._id),
            provider: callLog.provider,
            attemptedAt: callLog.startedAt || callLog.createdAt || now,
            durationSeconds: Math.max(0, Number(callLog.durationSeconds) || 0),
          },
        },
        $inc: { version: 1 },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ success: false, message: "No-show claim could not be opened. Refresh and retry.", result: {} });
    }

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentReports = await ServiceBooking.countDocuments({
      technicianId: technicianProfileId,
      customerNoShowReportedAt: { $gte: thirtyDaysAgo },
    });
    await TechnicianProfile.updateOne(
      { _id: technicianProfileId },
      {
        $inc: { customerNoShowReportCount: 1 },
        $set: { reliabilityReviewRequired: recentReports >= 3 },
      }
    );

    if (req.io) {
      req.io.to(`customer_${updated.customerId}`).emit("customer_no_show_reported", {
        bookingId: updated._id,
        responseDeadline,
        message: "Your technician reported that you were not available. Please respond within 10 minutes.",
      });
    }
    const { sendPushNotification } = await import("../Utils/sendNotification.js");
    await sendPushNotification(updated.customerId.toString(), {
      title: "Technician waiting",
      body: "Your technician reported you were not available. Please respond within 10 minutes.",
      data: { bookingId: String(updated._id), type: "CUSTOMER_NO_SHOW_RESPONSE" },
    }, { recipientType: "customer" }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "No-show reported. The customer has 10 minutes to respond.",
      result: {
        bookingId: updated._id,
        customerNoShowStatus: updated.customerNoShowStatus,
        responseDeadline,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

export const respondToCustomerNoShow = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking id", result: {} });
    }
    const booking = await ServiceBooking.findOne({ _id: id, customerId: req.user.userId });
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    if (booking.customerNoShowStatus !== "awaiting_customer") {
      return res.status(409).json({ success: false, message: "There is no open no-show claim for this booking.", result: {} });
    }

    const available = req.body?.available !== false;
    const now = new Date();
    if (available) {
      const updated = await ServiceBooking.findOneAndUpdate(
        { _id: id, customerNoShowStatus: "awaiting_customer" },
        {
          $set: {
            customerNoShowStatus: "rejected",
            customerNoShowResponseDeadline: null,
          },
          $inc: { version: 1 },
        },
        { new: true }
      );
      if (req.io && booking.technicianId) {
        req.io.to(`technician_${booking.technicianId}`).emit("customer_no_show_response", {
          bookingId: id,
          available: true,
          message: "Customer responded that they are available.",
        });
      }
      return res.status(200).json({
        success: true,
        message: "Response recorded. The technician has been told you are available.",
        result: { bookingId: id, customerNoShowStatus: updated?.customerNoShowStatus || "rejected" },
      });
    }

    const updated = await confirmCustomerNoShow({ booking, now });
    if (!updated) {
      return res.status(409).json({ success: false, message: "Claim was already resolved. Refresh and retry.", result: {} });
    }
    if (req.io && updated.technicianId) {
      req.io.to(`technician_${updated.technicianId}`).emit("customer_no_show_confirmed", {
        bookingId: id,
        compensationStatus: updated.customerNoShowCompensationStatus,
      });
    }
    return res.status(200).json({
      success: true,
      message: "No-show confirmed. Compensation is recorded for admin review; no automatic payout is made.",
      result: {
        bookingId: id,
        customerNoShowStatus: updated.customerNoShowStatus,
        compensationPaise: updated.customerNoShowCompensationPaise,
        compensationStatus: updated.customerNoShowCompensationStatus,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* =====================================================
   CANCEL BOOKING (CUSTOMER)
===================================================== */
export const cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format" });
    }

    const booking = await ServiceBooking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

    if (req.user.role !== "Customer" || booking.customerId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    if (booking.status === "cancelled" || booking.status === "completed") {
      return res.status(400).json({ success: false, message: "Booking cannot be cancelled in current status" });
    }

    const now = new Date();
    let fee = 0;
    const isLate = booking.assignedAt && (now - new Date(booking.assignedAt)) > 20 * 60 * 1000 && ["accepted"].includes(booking.status);
    const isScheduledLate = booking.scheduledAt && now > new Date(booking.scheduledAt.getTime() + 15 * 60 * 1000) && ["accepted", "on_the_way"].includes(booking.status);

    // 🏆 RULE 3: Free cancellation if technician is late > 15-20 mins
    if (isLate || isScheduledLate) {
      fee = 0;
    } else {
      if (booking.bookingType === "schedule") {
        const timeToSlot = (new Date(booking.scheduledAt) - now) / (1000 * 60 * 60);

        if (booking.status === "reached") {
          fee = 120; // At-Door Cancellation
        } else if (timeToSlot < 2) {
          fee = 100; // Late Cancellation (< 2 hours)
        } else if (timeToSlot < 3) {
          fee = 50; // Intermediate (implied between 3 and 2) or custom rule
        } else {
          fee = 0; // Free Cancellation (> 3 hours)
        }
      } else {
        // Instant Booking
        if (["accepted", "on_the_way"].includes(booking.status)) {
          fee = 50;
        } else if (booking.status === "reached") {
          fee = 120;
        } else {
          fee = 0; // Still pending
        }
      }
    }

    // 🎯 ATOMIC CANCEL CLAIM — only one cancellation can win. Status must be
    // cancellable per the canonical transition table and not already cancelled.
    // H17: the claim additionally pins the status (and technician assignment)
    // observed at fee-computation time, so a concurrent accept/arrive between
    // the read and the claim cannot silently misprice the fee — the customer
    // retries and the fee is recomputed from fresh state.
    const cancelled = await ServiceBooking.findOneAndUpdate(
      {
        _id: id,
        status: booking.status,
        cancellationStatus: "active",
        technicianId: booking.technicianId,
      },
      {
        $set: {
          status: "cancelled",
          cancelledBy: "customer",
          cancelledAt: now,
          reacceptEligible: false,
          cancelReason: reason || "customer_cancel",
          cancellationStatus: "customer_cancelled",
          cancellationFee: fee,
          cancellationFeePaise: Math.round(fee * 100),
          // Recorded fees are NOT collected revenue until a real collection
          // mechanism exists — flag it explicitly for reports.
          cancellationFeeStatus: fee > 0 ? "not_collected" : "waived",
          assignmentStatus: "released",
          autoCancelAt: null,
          completionPinnedAt: null,
          completionOtpRequestedAt: null,
        },
        $inc: { version: 1 },
      },
      { new: true }
    );

    if (!cancelled) {
      return res.status(409).json({ success: false, message: "Booking cannot be cancelled in its current state" });
    }
    await closeActiveChallengesForBooking(id, { to: "cancelled" }).catch((cleanupErr) => {
      console.error("cancelBooking challenge cleanup failed:", cleanupErr.message);
    });

    await releaseScheduledSlot({ bookingId: id, reason: "customer_cancel" }).catch((releaseErr) => {
      console.error("cancelBooking slot release failed:", releaseErr.message);
    });

    // Release the technician's assignment history + expire pending offers
    if (cancelled.technicianId) {
      await ServiceBooking.updateOne(
        { _id: id },
        {
          $push: {
            assignmentAttempts: {
              technicianId: cancelled.technicianId,
              attemptNumber: (cancelled.assignmentAttempts?.length || 0) + 1,
              status: "released",
              acceptedAt: cancelled.assignedAt || null,
              releasedAt: now,
              releaseReason: "customer_cancel",
            },
          },
        }
      );
    }
    await JobBroadcast.updateMany(
      { bookingId: id, status: "sent" },
      { $set: { status: "expired" } }
    );
    await TechnicianBookingOffer.updateMany(
      { bookingId: id, decision: "offered" },
      { $set: { decision: "superseded" } }
    );

    // Notify the assigned technician (if any) that the job was cancelled
    if (cancelled.technicianId && req.io) {
      req.io.to(`technician_${cancelled.technicianId}`).emit("job_cancelled_by_customer", {
        bookingId: id,
        message: "This job was cancelled by the customer.",
        type: "BOOKING_CANCELLED",
      });
    }

    // NOTE: Customer cancellation fee is recorded for audit but not collected
    // until a customer wallet system is implemented. Do NOT claim the fee will
    // be charged until the deduction logic exists.
    // TODO: Implement customer wallet hold/deduction when wallet system is added.

    return res.status(200).json({
      success: true,
      message: fee > 0
        ? `Booking cancelled. A cancellation fee of ₹${fee} has been noted on your account.`
        : "Booking cancelled successfully.",
      result: {
        bookingId: cancelled._id,
        cancellationFee: fee,
        cancellationFeeStatus: cancelled.cancellationFeeStatus,
        status: "cancelled"
      }
    });
  } catch (error) {
    console.error("cancelBooking Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =====================================================
   TECHNICIAN CANCEL BOOKING (PENALTY ₹200 + RE-DISPATCH)
===================================================== */
export const technicianCancelBooking = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const techId = req.user.technicianProfileId;

    const booking = await ServiceBooking.findById(id).session(session);
    if (!booking) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (booking.technicianId?.toString() !== techId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: "Not authorized to cancel this booking" });
    }

    // ✅ Cancellable states only (canonical transition table)
    if (!["accepted", "on_the_way", "reached", "in_progress"].includes(booking.status) ||
        booking.cancellationStatus !== "active") {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Booking cannot be cancelled in current status" });
    }

    // 💰 PENALTY — paise-based, policy-configurable. This is a recorded
    // liability on the technician wallet, NOT platform revenue.
    const PENALTY_PAISE = Number(process.env.TECHNICIAN_CANCEL_PENALTY_PAISE) || 20000; // ₹200
    const penaltyPaise = PENALTY_PAISE;
    const eventId = crypto.randomUUID();
    const idempotencyKey = `penalty:${id}:${techId}:${eventId}`;
    const now = new Date();

    // 1. Atomic wallet debit (only if sufficient funds); shortfall tracked
    //    as an outstanding receivable on the booking for reconciliation.
    let debitedPaise = 0;
    const technician = await TechnicianProfile.findById(techId).session(session);
    if (technician) {
      const wallet = technician;
      const available = wallet.availableBalancePaise || 0;
      debitedPaise = Math.min(available, penaltyPaise);
      if (debitedPaise > 0) {
        const debitResult = await TechnicianProfile.findOneAndUpdate(
          { _id: techId, availableBalancePaise: { $gte: debitedPaise } },
          { $inc: { availableBalancePaise: -debitedPaise } },
          { new: true, session }
        );
        if (!debitResult) {
          await session.abortTransaction();
          return res.status(409).json({ success: false, message: "Wallet changed concurrently, please retry" });
        }
      }
      // H11: uncollectable shortfall becomes outstanding dues (recovered
      // from future settlements) instead of silently vanishing.
      const duesShortfall = penaltyPaise - debitedPaise;
      if (duesShortfall > 0) {
        await TechnicianProfile.updateOne(
          { _id: techId },
          { $inc: { outstandingDuesPaise: duesShortfall, walletVersion: 1 } },
          { session }
        );
      }

      // 2. Penalty transaction — idempotency key makes double-processing
      //    impossible even if this request is retried.
      const [penaltyTxn] = await WalletTransaction.create([{
        technicianId: techId,
        bookingId: id,
        amountPaise: debitedPaise,
        amount: debitedPaise / 100,
        type: "debit",
        source: "penalty",
        idempotencyKey,
        note: `Penalty for cancelling job after acceptance: ${reason || "No reason provided"}`,
      }], { session });

      // 3. Increment rejection count ONCE (guarded by the atomic claim below)
      await TechnicianProfile.updateOne(
        { _id: techId },
        { $inc: { jobRejectCount: 1 } }
      ).session(session);

      // 4. Atomically claim the cancellation (rejects concurrent duplicates)
      const claimed = await ServiceBooking.findOneAndUpdate(
        {
          _id: id,
          technicianId: techId,
          status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
          cancellationStatus: "active",
        },
        {
          $set: {
            cancellationStatus: "technician_cancelled",
            technicianPenaltyPaise: penaltyPaise,
            technicianPenaltyDebitedPaise: debitedPaise,
          },
          $inc: { version: 1 },
        },
        { new: false, session }
      );
      if (!claimed) {
        await session.abortTransaction();
        return res.status(409).json({ success: false, message: "Booking was already processed" });
      }

      // 5. Record the release in assignment-attempt history (preserved for
      //    re-dispatch and disputes — never overwrite the first technician).
      await ServiceBooking.updateOne(
        { _id: id },
        {
          $push: {
            assignmentAttempts: {
              technicianId: techId,
              attemptNumber: (booking.assignmentAttempts?.length || 0) + 1,
              status: "released",
              acceptedAt: booking.assignedAt || null,
              releasedAt: now,
              releaseReason: "technician_cancel",
              penaltyTransactionId: penaltyTxn._id,
            },
          },
        }
      ).session(session);
    }

    // 6. Expire the old broadcasts and offers for this booking (in transaction)
    await JobBroadcast.updateMany(
      { bookingId: id, status: { $in: ["sent", "accepted", "expired"] } },
      {
        $set: {
          status: "expired",
          expiredAt: now,
          expiredReason: "technician_cancelled",
          lastPushedAt: null,
          lastPushedVersion: null,
        },
      },
      { session }
    );
    // The cancelling technician declined this job for re-dispatch purposes;
    // keep them suppressed while the booking is re-broadcast.
    await JobBroadcast.updateOne(
      { bookingId: id, technicianId: techId },
      {
        $set: {
          status: "rejected",
          respondedAt: now,
          expiredAt: null,
          expiredReason: null,
          lastPushedAt: null,
          lastPushedVersion: null,
        },
      },
      { session }
    );
    await TechnicianBookingOffer.updateMany(
      { bookingId: id, decision: { $in: ["offered", "accepted"] } },
      { $set: { decision: "expired" } },
      { session }
    );

    // 7. Reset booking to pending for re-dispatch (instead of leaving it cancelled)
    const isSlotStillFuture = booking.bookingType === "schedule" && booking.scheduledAt && booking.scheduledAt > now;

    if (isSlotStillFuture) {
      // Scheduled booking with future slot: reset to pending for re-broadcast
      booking.status = "pending";
      booking.assignmentStatus = "unassigned";
      booking.technicianId = null;
      booking.technicianSnapshot = null;
      booking.assignedAt = null;
      booking.completionPinnedAt = null;
      const redispatchWindowMs = SCHEDULED_REDISPATCH_WINDOW_MINUTES * 60 * 1000;
      booking.autoCancelAt = new Date(Math.max(
        now.getTime() + redispatchWindowMs,
        booking.scheduledAt.getTime() - 5 * 60 * 60 * 1000
      ));
      booking.dispatchEligibleAt = now;
      booking.lastRebroadcastAt = null;
      booking.broadcastedAt = null;
      booking.matchingLeaseUntil = null;
      booking.matchingLeaseOwner = null;
      booking.cancelReason = null;
      booking.cancelledBy = null;
      booking.cancelledAt = null;
      booking.cancellationStatus = "active";
      booking.reacceptEligible = false;
      booking.technicianPenalty = penaltyPaise / 100;
      booking.technicianRejectCount = (booking.technicianRejectCount || 0) + 1;
      if (booking.remindersSent) {
        for (const key of Object.keys(booking.remindersSent.toObject?.() || booking.remindersSent)) {
          booking.remindersSent[key] = false;
        }
      }
      await booking.save({ session });
    } else {
      // Instant booking or past slot: cancel permanently
      booking.status = "cancelled";
      booking.cancelledBy = "technician";
      booking.cancelledAt = now;
      booking.reacceptEligible = true;
      booking.cancelReason = reason || "technician_cancel";
      booking.technicianPenalty = penaltyPaise / 100;
      booking.assignmentStatus = "released";
      booking.autoCancelAt = null;
      booking.completionPinnedAt = null;
      await booking.save({ session });
    }

    await closeActiveChallengesForBooking(id, { to: "cancelled", session });

    await session.commitTransaction();

    if (isSlotStillFuture) {
      const activeHold = await getActiveHoldForBooking(id);
      await TechnicianSlot.updateMany(
        { bookingId: id, active: true },
        { $set: { active: false, releasedAt: now, releaseReason: "technician_cancel" } }
      );
      if (activeHold) {
        await revertConfirmedCapacityToHeld(activeHold.capacityKeys);
        await SlotHold.updateOne(
          { _id: activeHold._id, active: true },
          { $set: { status: "held", technicianId: null, confirmedAt: null } }
        );
      }
    } else {
      await releaseScheduledSlot({ bookingId: id, reason: "technician_cancel" }).catch(() => {});
    }

    // 8. Notify customer + re-dispatch (outside transaction for socket/perf)
    if (req.io) {
      if (isSlotStillFuture) {
        // Re-broadcast to find a replacement
        notifyCustomerOfRebroadcast(booking, req.io).catch(() => {});
        matchAndBroadcastBooking(booking._id, req.io).catch((err) =>
          console.error("Re-broadcast after tech-cancel failed:", err.message)
        );
      } else {
        req.io.to(`customer_${booking.customerId}`).emit("booking_cancelled", {
          ...toBookingCancelledDTO(booking, "technician_cancel"),
          message: "Your technician had to cancel. The booking has been cancelled."
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: isSlotStillFuture
        ? `Booking cancelled. A penalty of ₹${(penaltyPaise / 100)} has been debited. We are searching for a replacement technician.`
        : `Booking cancelled. A penalty of ₹${(penaltyPaise / 100)} has been debited from your wallet.`,
      result: {
        penaltyPaise,
        penaltyDebitedPaise: debitedPaise,
        penaltyOutstandingPaise: penaltyPaise - debitedPaise,
        walletBalance: (technician?.availableBalancePaise || 0) / 100,
        redisplay: isSlotStillFuture,
      }
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("technicianCancelBooking Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
};

/* =====================================================
   TECHNICIAN RE-ACCEPT CANCELLED JOB
   (OPTIONAL PENALTY — % OF BOOKING TOTAL, ADMIN-CONFIGURED)
   Penalty percent is a global admin setting:
     "technician.reacceptPenaltyPercent" (0–100), managed via
     GET/PUT /api/admin/settings/reaccept-penalty.
   H18: penalty applicability is SERVER-AUTHORITATIVE. The penalty applies
   if and only if the technician is re-accepting a job THEY cancelled
   (cancelledBy technician) and the admin percent yields a positive amount.
   Any client-supplied `withPenalty` flag is IGNORED (accepted for backward
   compatibility but never trusted) — a manipulated payload can neither
   dodge a due penalty nor impose one where policy says none.
   Per the admin setting: "debited when a technician re-accepts a job
   they cancelled."
   ===================================================== */
export const acceptCancelledJob = async (req, res) => {
  // B-09 two-phase re-acceptance (mirrors respondToJob): Phase A performs
  // advisory reads + eligibility outside any transaction; Phase B opens a
  // SHORT transaction that re-reads live state, re-validates eligibility,
  // then debits penalty + revives atomically. Revocations landing before
  // Phase B deterministically lose; only changes inside the short window
  // remain invisible (documented consistency boundary).
  let session = null;
  let reacceptLockAt = null;
  let reacceptLockTechId = null;
  try {
    const { id } = req.params;
    // H18: client-supplied penalty flags are never trusted (see header).
    const techId = req.user.technicianProfileId;

    if (!techId) {
      return res.status(401).json({ success: false, message: "Unauthorized. Technician profile not found." });
    }

    // 🛡 Activation gate — suspended/unapproved/KYC-incomplete technicians
    // must not re-accept jobs.
    const activation = await checkTechnicianActivation(techId);
    if (!activation.isActive) {
      return res.status(403).json({ success: false, message: activation.message });
    }

    const dispatchLockAt = new Date(Date.now() + DISPATCH_LOCK_MS);
    const dispatchLock = await TechnicianProfile.findOneAndUpdate(
      {
        _id: techId,
        $or: [
          { dispatchLockUntil: null },
          { dispatchLockUntil: { $lte: new Date() } },
        ],
      },
      { $set: { dispatchLockUntil: dispatchLockAt } },
      { new: true, select: "_id" }
    );
    if (!dispatchLock) {
      return res.status(409).json({
        success: false,
        message: "Another dispatch action is in progress. Please retry.",
        reason: "dispatch_lock_busy",
      });
    }
    reacceptLockAt = dispatchLockAt;
    reacceptLockTechId = techId;

    const booking = await ServiceBooking.findById(id)
      .populate("customerId", "fname lname mobileNumber email")
      .populate({ path: "serviceId", populate: { path: "categoryId" } });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    // ✅ Only a CANCELLED job that was assigned to this technician can be re-accepted.
    if (booking.status !== "cancelled") {
      return res.status(400).json({ success: false, message: "Only cancelled jobs can be re-accepted" });
    }
    if (booking.technicianId?.toString() !== techId?.toString()) {
      return res.status(403).json({ success: false, message: "This job was not assigned to you" });
    }

    const reacceptPolicy = evaluateReacceptEligibility({ booking });
    if (!reacceptPolicy.eligible) {
      return res.status(reacceptPolicy.reason === "not_cancelled" ? 400 : 409).json({
        success: false,
        message: REACCEPT_REJECT_MESSAGES[reacceptPolicy.reason] || "This job cannot be re-accepted",
        code: "REACCEPT_NOT_ALLOWED",
        reason: reacceptPolicy.reason,
      });
    }

    // ⚔️ One active job at a time — same guard as a fresh accept.
    const activeJob = await ServiceBooking.findOne({
      technicianId: techId,
      $or: [
        { status: { $in: ["on_the_way", "reached", "in_progress"] } },
        { status: { $in: ["accepted", "ACCEPTED"] }, bookingType: "instant" },
      ],
    }).select("_id status bookingType");
    if (activeJob) {
      return res.status(409).json({
        success: false,
        message:
          activeJob.status === "accepted" || activeJob.status === "ACCEPTED"
            ? "Please start travel for your current job before re-accepting."
            : "You are already on a job. Complete it before re-accepting another.",
      });
    }

    // B-04: cancelled-job re-acceptance must enforce the SAME canonical
    // ACCEPT-mode eligibility as ordinary acceptance (respondToJob).
    // Advisory here; authoritative re-check runs inside Phase B.
    const eligibility = await checkTechnicianEligibility({
      technician: techId,
      booking,
    });
    if (!eligibility.eligible) {
      return res.status(403).json({
        success: false,
        message: "You are no longer eligible to accept this job.",
        code: "TECHNICIAN_INELIGIBLE",
        reasons: eligibility.reasons,
        details: eligibility.details,
      });
    }

    const [queueMap, techProfileForCheck] = await Promise.all([
      loadCommittedQueues([techId]),
      TechnicianProfile.findById(techId).select("location serviceBaseLocation").lean(),
    ]);
    const feasibility = evaluateJobFeasibility({
      techLocation: getTechnicianOrigin(techProfileForCheck, booking.bookingType)?.location || null,
      candidateJob: booking,
      queue: queueMap.get(String(techId)),
    });
    if (!feasibility.feasible) {
      return res.status(409).json({
        success: false,
        message: "This job no longer fits your schedule.",
        code: "JOB_NOT_FEASIBLE",
        reason: feasibility.reason,
        result: { feasibility },
      });
    }

    // B-09 deterministic test hook (inert in production): runs after the
    // advisory checks and BEFORE the claim transaction opens.
    await globalThis.__b09OnEligible?.();

    // ================= PHASE B — CLAIM TRANSACTION (fresh snapshot) ======
    session = await mongoose.startSession();
    session.startTransaction();
    session.__b09ClaimTxn = true;

    const live = await ServiceBooking.findById(id).session(session);
    if (!live) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (live.status !== "cancelled") {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Only cancelled jobs can be re-accepted" });
    }
    if (live.technicianId?.toString() !== techId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: "This job was not assigned to you" });
    }

    const liveReacceptPolicy = evaluateReacceptEligibility({ booking: live });
    if (!liveReacceptPolicy.eligible) {
      await session.abortTransaction();
      return res.status(liveReacceptPolicy.reason === "not_cancelled" ? 400 : 409).json({
        success: false,
        message: REACCEPT_REJECT_MESSAGES[liveReacceptPolicy.reason] || "This job cannot be re-accepted",
        code: "REACCEPT_NOT_ALLOWED",
        reason: liveReacceptPolicy.reason,
      });
    }

    const liveActiveJob = await ServiceBooking.findOne({
      technicianId: techId,
      $or: [
        { status: { $in: ["on_the_way", "reached", "in_progress"] } },
        { status: { $in: ["accepted", "ACCEPTED"] }, bookingType: "instant" },
      ],
    })
      .session(session)
      .select("_id status bookingType");
    if (liveActiveJob) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: "You are already on a job. Complete it before re-accepting another.",
      });
    }
    const recheck = await checkTechnicianEligibility({ technician: techId, booking: live });
    if (!recheck.eligible) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: "You are no longer eligible to accept this job.",
        code: "TECHNICIAN_INELIGIBLE",
        reasons: recheck.reasons,
        details: recheck.details,
      });
    }

    const now = new Date();

    // 💰 OPTIONAL PENALTY — admin-configured % of the booking total (paise).
    // H18: applicability decided from the authoritative booking record
    // (technician-cancelled only), never from the request payload.
    let penaltyPaise = 0;
    let debitedPaise = 0;
    let penaltyTxnId = null;
    let technician = null;
    const applyPenalty = live.cancelledBy === "technician";

    if (applyPenalty) {
      const percent = await getReacceptPenaltyPercent();
      const totalAmountPaise = live.financialSnapshot?.totalAmountPaise || 0;
      penaltyPaise = percentageOf(totalAmountPaise, percent);
      if (penaltyPaise > 0) {
        const eventId = crypto.randomUUID();
        const idempotencyKey = `reaccept-penalty:${id}:${techId}:${eventId}`;

        technician = await TechnicianProfile.findById(techId).session(session);
        const available = technician?.availableBalancePaise || 0;
        debitedPaise = Math.min(available, penaltyPaise);

        if (debitedPaise > 0) {
          const debitResult = await TechnicianProfile.findOneAndUpdate(
            { _id: techId, availableBalancePaise: { $gte: debitedPaise } },
            { $inc: { availableBalancePaise: -debitedPaise } },
            { new: true, session }
          );
          if (!debitResult) {
            await session.abortTransaction();
            return res.status(409).json({ success: false, message: "Wallet changed concurrently, please retry" });
          }
        }
        // H11: uncollectable re-accept shortfall becomes outstanding dues.
        const reacceptShortfall = penaltyPaise - debitedPaise;
        if (applyPenalty && penaltyPaise > 0 && reacceptShortfall > 0) {
          await TechnicianProfile.updateOne(
            { _id: techId },
            { $inc: { outstandingDuesPaise: reacceptShortfall, walletVersion: 1 } },
            { session }
          );
        }

        const [penaltyTxn] = await WalletTransaction.create(
          [
            {
              technicianId: techId,
              bookingId: id,
              amountPaise: debitedPaise,
              amount: debitedPaise / 100,
              type: "debit",
              source: "penalty",
              idempotencyKey,
              note: `Penalty (${percent}% of booking total) for re-accepting a cancelled job`,
            },
          ],
          { session }
        );
        penaltyTxnId = penaltyTxn._id;
      }
    }

    // 🎯 Re-accept — atomically revive the booking. Guards against a
    // concurrent re-process (e.g. double-tap) via the status predicate.
    const technicianProfile = await TechnicianProfile.findById(techId)
      .session(session)
      .select("userId");
    const technicianUser = await User.findById(technicianProfile?.userId)
      .session(session)
      .select("fname lname mobileNumber");
    const technicianSnapshot = {
      name: `${technicianUser?.fname || ""} ${technicianUser?.lname || ""}`.trim() || "Unknown",
      mobile: technicianUser?.mobileNumber || "",
      deleted: false,
    };

    const reaccepted = await ServiceBooking.findOneAndUpdate(
      {
        _id: id,
        status: "cancelled",
        technicianId: techId,
      },
      {
        $set: {
          status: "accepted",
          assignmentStatus: "assigned",
          technicianId: techId,
          technicianSnapshot,
          assignedAt: now,
          cancellationStatus: "active",
          cancelledBy: null,
          cancelReason: null,
          reacceptEligible: false,
          autoCancelAt: live.bookingType === "instant"
            ? new Date(now.getTime() + 30 * 60 * 1000)
            : computeAutoCancelAt("schedule", live.scheduledAt, now),
          completionPinnedAt: null,
          completionOtpRequestedAt: null,
          ...(penaltyPaise > 0
            ? {
                technicianPenaltyPaise: penaltyPaise,
                technicianPenaltyDebitedPaise: debitedPaise,
                technicianPenalty: penaltyPaise / 100,
              }
            : {}),
        },
        $push: {
          assignmentAttempts: {
            technicianId: techId,
            attemptNumber: (live.assignmentAttempts?.length || 0) + 1,
            status: "assigned",
            acceptedAt: now,
            releaseReason: null,
            note: "Re-accepted after cancellation",
            penaltyTransactionId: penaltyTxnId,
          },
        },
        $inc: { version: 1 },
      },
      { new: true, session }
    );

    if (!reaccepted) {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: "Booking was already processed" });
    }

    // Mark this technician's broadcast row accepted (if one still exists).
    await JobBroadcast.updateOne(
      { bookingId: id, technicianId: techId, status: "expired" },
      { $set: { status: "accepted" } },
      { session }
    );

    await session.commitTransaction();

    // 🔔 Notify customer (outside transaction)
    if (req.io && reaccepted.customerId) {
      notifyCustomerJobAccepted(req.io, reaccepted.customerId._id, {
        bookingId: reaccepted._id,
        technicianId: techId,
        status: "accepted",
      }).catch(() => {});
    }

    const bookingData = reaccepted.toObject ? reaccepted.toObject() : reaccepted;
    const { baseAmount, ...bookingWithoutBaseAmount } = bookingData;
    bookingWithoutBaseAmount.technicianAmount =
      bookingData.serviceId?.technicianAmount || bookingData.technicianAmount || 0;

    return res.status(200).json({
      success: true,
      message: penaltyPaise > 0
        ? `Job re-accepted. A penalty of ₹${(penaltyPaise / 100).toFixed(2)} (${await getReacceptPenaltyPercent()}% of booking total) has been debited from your wallet.`
        : "Job re-accepted successfully without penalty",
      result: {
        ...bookingWithoutBaseAmount,
        penalty: {
          applied: penaltyPaise > 0,
          penaltyPaise,
          penaltyDebitedPaise: debitedPaise,
          penaltyOutstandingPaise: penaltyPaise - debitedPaise,
          // H18 auditability: server-decided basis (pre-reaccept cancelledBy).
          penaltyBasis: live.cancelledBy || null,
          walletBalance: (technician?.availableBalancePaise || 0) / 100,
        },
      },
    });
  } catch (error) {
    // B-09: commit/write conflicts mean a concurrent state change won —
    // retryable 409, never partial (all mutations were in-transaction).
    try {
      if (session && session.inTransaction()) await session.abortTransaction();
    } catch {
      /* already aborted */
    }
    const labels = error?.errorLabels || [];
    const msg = String(error?.message || "");
    const retryable =
      session?.__b09ClaimTxn === true &&
      (labels.includes("TransientTransactionError") ||
        labels.includes("UnknownTransactionCommitResult") ||
        error?.code === 112 ||
        /WriteConflict|WriteConcern|wtimeout/i.test(msg));
    console.error("acceptCancelledJob Error:", msg);
    if (retryable && !res.headersSent) {
      return res.status(409).json({
        success: false,
        message: "Booking changed concurrently. Please retry.",
        reason: "claim_conflict",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    if (reacceptLockAt && reacceptLockTechId) {
      try {
        await TechnicianProfile.updateOne(
          { _id: reacceptLockTechId, dispatchLockUntil: reacceptLockAt },
          { $set: { dispatchLockUntil: new Date() } }
        );
      } catch {
        /* lock expires on its own */
      }
    }
    try {
      session?.endSession();
    } catch {
      /* already ended */
    }
  }
};

/* =====================================================
   GET ADMIN JOB HISTORY (WITH TECHNICIAN SNAPSHOT FALLBACK)
===================================================== */
export const getAdminJobHistory = async (req, res) => {
  try {
    const userRole = req.user?.role;

    // Only Owner/Admin can access
    if (userRole !== "Owner" && userRole !== "Admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Owner/Admin only.",
        result: {},
      });
    }

    const { technicianId, status } = req.query;

    // Build query
    const query = {};
    if (technicianId) {
      if (!mongoose.Types.ObjectId.isValid(technicianId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid technician ID",
          result: {},
        });
      }
      query.technicianId = technicianId;
    }

    if (status) {
      const allowedStatuses = [
        "pending", "broadcasted", "accepted", "on_the_way",
        "reached", "in_progress", "completed", "cancelled", "expired"
      ];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status",
          result: {},
        });
      }
      query.status = status;
    }

    // Fetch jobs with population
    const jobs = await ServiceBooking.find(query)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType serviceCost")
      .populate("technicianId", "userId profileImage rating totalJobsCompleted")
      .sort({ createdAt: -1 })
      .lean();

    // Enrich with technician snapshot if profile deleted
    const enrichedJobs = jobs.map(job => {
      if (!job.technicianId && job.technicianSnapshot?.deleted) {
        // Technician deleted, show snapshot
        job.technicianInfo = {
          deleted: true,
          name: job.technicianSnapshot.name,
          mobile: job.technicianSnapshot.mobile,
        };
      } else if (job.technicianId) {
        // Technician exists, show live data
        job.technicianInfo = {
          deleted: false,
          id: job.technicianId._id,
          userId: job.technicianId.userId,
          profileImage: job.technicianId.profileImage,
          rating: job.technicianId.rating,
          totalJobsCompleted: job.technicianId.totalJobsCompleted,
        };
      } else {
        // No technician assigned yet
        job.technicianInfo = null;
      }
      return job;
    });

    return res.status(200).json({
      success: true,
      message: "Job history fetched successfully",
      result: enrichedJobs,
    });
  } catch (error) {
    console.error("getAdminJobHistory:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* =====================================================
   GET ALL BOOKINGS & CUSTOMERS (PUBLIC/MANAGEMENT)
   Filters: status, customerMobile, technicianMobile
===================================================== */
export const getOwnerAllBookings = async (req, res) => {
  try {
    const { status, customerMobile, technicianMobile, limit = 50, skip = 0 } = req.query;

    // 1. Build Query
    let query = {};

    // 🔗 Filter by Customer Mobile
    const User = mongoose.model("User");
    if (customerMobile) {
      const customer = await User.findOne({ mobileNumber: customerMobile, role: "Customer" });
      if (customer) {
        query.customerId = customer._id;
      } else {
        // If mobile provided but not found, return empty (or continue with search that will yield empty)
        query.customerId = new mongoose.Types.ObjectId(); // Non-existent ID
      }
    }

    // 🔗 Filter by Technician Mobile
    if (technicianMobile) {
      const techUser = await User.findOne({ mobileNumber: technicianMobile, role: "Technician" });
      if (techUser) {
        const TechnicianProfile = mongoose.model("TechnicianProfile");
        const profile = await TechnicianProfile.findOne({ userId: techUser._id });
        if (profile) {
          query.technicianId = profile._id;
        } else {
          query.technicianId = new mongoose.Types.ObjectId();
        }
      } else {
        query.technicianId = new mongoose.Types.ObjectId();
      }
    }

    // 📌 Filter by Status
    if (status) {
      if (status === "expired") {
        const JobBroadcast = mongoose.model("JobBroadcast");
        const expiredBroadcasts = await JobBroadcast.find({ status: "expired" }).select("bookingId");
        const expiredBookingIds = expiredBroadcasts.map(b => b.bookingId);
        query = {
          ...query,
          $or: [
            { _id: { $in: expiredBookingIds } },
            { status: "expired" }
          ]
        };
      } else {
        // Support any other status (accepted, completed, in_progress, etc.)
        query.status = status;
      }
    }

    const bookings = await ServiceBooking.find(query)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType serviceCost")
      .populate({
        path: "technicianId",
        select: "userId profileImage",
        populate: {
          path: "userId",
          select: "mobileNumber fname lname"
        }
      })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    // 2. Fetch All Customers as requested
    const customers = await User.find({ role: "Customer" })
      .select("fname lname mobileNumber email status profileComplete")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Bookings and Customers fetched successfully",
      result: {
        bookings,
        customers,
        totalBookings: bookings.length,
        totalCustomers: customers.length
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =====================================================
   GET BOOKING BY ID (PUBLIC/MANAGEMENT)
===================================================== */
export const getOwnerBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID" });
    }

    const booking = await ServiceBooking.findById(id)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType description serviceCost technicianAmount")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "fname lname mobileNumber" }
      })
      .populate("addressId");

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Booking details fetched successfully",
      result: booking,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =====================================================
   GET CANCELLATION REASONS (ALL ROLES)
===================================================== */
export const getCancellationReasons = async (req, res) => {
  const customerReasons = [
    { id: "change_of_plans", label: "Change of plans" },
    { id: "booked_by_mistake", label: "Booked by mistake" },
    { id: "technician_late", label: "Technician is late" },
    { id: "found_better_price", label: "Found better price elsewhere" },
    { id: "work_already_done", label: "Work already done" },
    { id: "other", label: "Other" }
  ];

  const technicianReasons = [
    { id: "traffic_heavy", label: "Heavy traffic / Distance too far" },
    { id: "vehicle_breakdown", label: "Vehicle breakdown" },
    { id: "personal_emergency", label: "Personal emergency" },
    { id: "wrong_service_selected", label: "Incorrect service selected by customer" },
    { id: "parts_unavailable", label: "Required parts unavailable" },
    { id: "other", label: "Other" }
  ];

  return res.status(200).json({
    success: true,
    result: {
      customer: customerReasons,
      technician: technicianReasons
    }
  });
};

/* =====================================================
   DELETE ALL CUSTOMER BOOKINGS (CLEANUP)
===================================================== */
export const deleteAllCustomerBookings = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }

    const { userId } = req.user;

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // 1. Delete all Service Bookings for this customer
      const serviceBookings = await ServiceBooking.find({ customerId: userId }).select("_id").session(session);
      const bookingIds = serviceBookings.map(b => b._id);

      await ServiceBooking.deleteMany({ customerId: userId }).session(session);

      // 2. Delete associated Job Broadcasts
      await JobBroadcast.deleteMany({ bookingId: { $in: bookingIds } }).session(session);

      // 3. Delete all Product Bookings for this customer
      await ProductBooking.deleteMany({ customerId: userId }).session(session);
    });
    session.endSession();

    console.log(`🗑️ Customer ${userId} wiped their entire booking history.`);

    return res.status(200).json({
      success: true,
      message: "All service and product bookings deleted successfully",
      result: {},
    });
  } catch (error) {
    console.error("deleteAllCustomerBookings Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during cleanup",
      result: { error: error.message },
    });
  }
};

// 🔄 Re-export Book Again endpoints for modular accessibility
export { getCompletedServices, rebookService } from "./bookAgainController.js";

/* =====================================================
   DELETE A SINGLE SERVICE BOOKING (CUSTOMER)
   - Customer can only delete their own booking.
   - Deletion is blocked once money is involved (paid) or a
     technician is engaged/completed to protect financial integrity
     and audit trail. Allowed states: pending / broadcasted /
     cancelled / expired (i.e. technicianId === null and not paid).
   - Cascades to the booking's broadcast / offer / outbox rows.
   ===================================================== */
const DELETABLE_BOOKING_STATUSES = ["pending", "broadcasted", "cancelled", "expired"];

export const deleteServiceBooking = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Booking id is required", result: {} });
    }

    const booking = await ServiceBooking.findOne({ _id: id, customerId: req.user.userId });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    }

    // 🔒 Guard: protect paid / in-progress / technician-engaged bookings
    if (booking.paymentStatus === "paid") {
      return res.status(409).json({
        success: false,
        message: "Cannot delete a booking that has been paid. Cancel it instead.",
        result: {},
      });
    }
    if (booking.technicianId) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete a booking assigned to a technician. Cancel it instead.",
        result: {},
      });
    }
    if (!DELETABLE_BOOKING_STATUSES.includes(booking.status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete a booking in '${booking.status}' state. Cancel it instead.`,
        result: {},
      });
    }

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await ServiceBooking.deleteOne({ _id: booking._id }).session(session);
      await JobBroadcast.deleteMany({ bookingId: booking._id }).session(session);
      await TechnicianBookingOffer.deleteMany({ bookingId: booking._id }).session(session);
      await BookingOutbox.deleteMany({ bookingId: booking._id }).session(session);
      await DispatchOutbox.deleteMany({ bookingId: booking._id }).session(session);
    });
    session.endSession();

    console.log(`🗑️ Customer ${req.user.userId} deleted booking ${booking._id}`);

    return res.status(200).json({
      success: true,
      message: "Booking deleted successfully",
      result: { deletedBookingId: String(booking._id) },
    });
  } catch (error) {
    console.error("deleteServiceBooking Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while deleting booking",
      result: { error: error.message },
    });
  }
};

/* =====================================================
   DELETE A SERVICE BOOKING (ADMIN / OWNER)
   - Privileged hard delete of ANY booking by id, with full
     cascade cleanup. Use with care — this erases the record.
   ===================================================== */
export const deleteBookingAsAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Booking id is required", result: {} });
    }

    const booking = await ServiceBooking.findById(id);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    }

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await ServiceBooking.deleteOne({ _id: booking._id }).session(session);
      await JobBroadcast.deleteMany({ bookingId: booking._id }).session(session);
      await TechnicianBookingOffer.deleteMany({ bookingId: booking._id }).session(session);
      await BookingOutbox.deleteMany({ bookingId: booking._id }).session(session);
      await DispatchOutbox.deleteMany({ bookingId: booking._id }).session(session);
    });
    session.endSession();

    console.log(`🗑️ Admin ${req.user?.userId} deleted booking ${booking._id}`);

    return res.status(200).json({
      success: true,
      message: "Booking deleted successfully (admin)",
      result: { deletedBookingId: String(booking._id) },
    });
  } catch (error) {
    console.error("deleteBookingAsAdmin Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while deleting booking",
      result: { error: error.message },
    });
  }
};

