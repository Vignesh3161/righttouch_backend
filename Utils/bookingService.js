/**
 * 📦 SHARED BOOKING CREATION SERVICE
 *
 * One common pipeline for:
 *   - POST /api/user/booking/schedule
 *   - POST /api/cart/checkout
 *   - POST /api/user/booking/book-again
 *
 * Guarantees:
 *   - Server-side pricing only (client money values are ignored)
 *   - Immutable financial snapshot + commission resolved exactly once
 *   - Timezone-safe slot validation (shared with the slots endpoint)
 *   - Booking + BOOKING_CREATED outbox row in ONE transaction
 *   - Broadcast only after commit (inline fast path + outbox retry)
 */

import ServiceBooking from "../Schemas/ServiceBooking.js";
import BookingOutbox from "../Schemas/BookingOutbox.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import { resolveZoneFromCoordinates } from "./resolveZoneFromCoordinates.js";
import { resolveCommissionSnapshot } from "./commission.js";
import { paiseToRupees } from "./money.js";
import { matchAndBroadcastBooking } from "./technicianMatching.js";
import { validateSlot, BUSINESS_TIMEZONE, localDateInBusinessTimezone, formatInBusinessTimezone } from "./slots.js";
import { normalizeBookingStatus } from "./bookingStatus.js";

/**
 * Validate that a service may be booked from the given zone.
 * FINAL RULE: address must resolve to BOTH District AND Zone, zone must be
 * active, service globally active, and an active ZoneServiceMapping must exist.
 * @returns {{ ok: boolean, zoneId: mongoose.Types.ObjectId|null, error?: string }}
 */
export const resolveServiceZoneAvailability = async ({
  service,
  latitude,
  longitude,
  session,
}) => {
  const FRIENDLY = "Service unavailable in this area. This service is currently not available at the selected address.";
  const resolved = await resolveZoneFromCoordinates(latitude, longitude, { session, includeInactive: true });
  if (resolved.zone && resolved.zone.active === false) {
    return {
      ok: false,
      zoneId: resolved.zone?._id || null,
      districtId: resolved.zone?.operationalCityId || null,
      error: FRIENDLY,
      code: "SERVICE_NOT_AVAILABLE",
    };
  }
  // FINAL RULE: no zone polygon → block (no district fallback for booking).
  if (!resolved.zone?._id) {
    let districtId = null;
    if (latitude && longitude) {
      const { resolveOperationalCityFromCoordinates } = await import("./technicianMatching.js");
      const city = await resolveOperationalCityFromCoordinates(latitude, longitude);
      if (city?._id) districtId = city._id;
    }
    return {
      ok: false,
      zoneId: null,
      districtId,
      error: FRIENDLY,
      code: "SERVICE_NOT_AVAILABLE",
    };
  }
  let districtId = resolved.zone?.operationalCityId || null;
  if (!districtId && latitude && longitude) {
    const { resolveOperationalCityFromCoordinates } = await import("./technicianMatching.js");
    const city = await resolveOperationalCityFromCoordinates(latitude, longitude);
    if (city?._id) districtId = city._id;
  }
  if (!districtId) {
    return { ok: false, zoneId: resolved.zone?._id || null, districtId, error: FRIENDLY, code: "SERVICE_NOT_AVAILABLE" };
  }

  const { resolveServiceAvailability } = await import("../Services/serviceAvailabilityService.js");
  const avail = await resolveServiceAvailability({
    serviceId: service?._id,
    districtId,
    cityId: resolved.zone?._id || null,
  });

  if (!avail.available) {
    return {
      ok: false,
      zoneId: resolved.zone?._id || null,
      districtId,
      error: FRIENDLY,
      code: "SERVICE_NOT_AVAILABLE",
    };
  }

  return { ok: true, zoneId: resolved.zone?._id || null, districtId };
};

/**
 * Resolve booking type + scheduledAt from client input, validating the slot
 * against the SAME utility the slots endpoint uses.
 *
 * @returns {{ bookingType: "instant"|"schedule", scheduledAt: Date|null,
 *             timezone: string|null, scheduledDateLocal: string|null,
 *             scheduledTimeLocal: string|null, error?: string }}
 */
export const resolveScheduleInput = (body, { now = new Date() } = {}) => {
  const bookingType = body?.bookingType === "scheduled" ? "schedule" : "instant";

  if (bookingType === "instant") {
    return {
      bookingType,
      scheduledAt: null,
      timezone: null,
      scheduledDateLocal: null,
      scheduledTimeLocal: null,
    };
  }

  const { scheduledDate, scheduledTime } = body;
  const validation = validateSlot(scheduledDate, scheduledTime, { now });

  if (!validation.valid) {
    return { bookingType, error: validation.error };
  }

  const local = formatInBusinessTimezone(validation.scheduledAt);
  return {
    bookingType,
    scheduledAt: validation.scheduledAt,
    timezone: BUSINESS_TIMEZONE,
    scheduledDateLocal: localDateInBusinessTimezone(validation.scheduledAt),
    scheduledTimeLocal: `${local.hours}:${local.minutes}`,
  };
};

/**
 * Compute autoCancelAt from the canonical rules:
 *   instant:  createdAt + 1 hour
 *   schedule: scheduledAt − 5 hours (floored to now + 5 min if already past)
 */
export const computeAutoCancelAt = (bookingType, scheduledAt, now = new Date()) => {
  if (bookingType === "schedule" && scheduledAt) {
    const at = new Date(scheduledAt.getTime() - 5 * 60 * 60 * 1000);
    return at > now ? at : new Date(now.getTime() + 5 * 60 * 1000);
  }
  return new Date(now.getTime() + 60 * 60 * 1000);
};

/**
 * Build the booking document (no DB writes). All money computed server-side.
 *
 * @param {Object} args
 * @param {Object} args.service        — active Service document
 * @param {Object} args.resolvedLocation — from resolveUserLocation
 * @param {Object} args.schedule       — from resolveScheduleInput
 * @param {number} args.tipAmountRupees
 * @param {string} args.customerId
 * @param {string} [args.addressId]
 * @param {string} [args.faultProblem]
 * @param {number} [args.quantity=1]   — cart quantity multiplier
 * @param {number} [args.baseAmountOverride=null] — chargeable base (e.g. live
 *   discounted price already resolved by the caller). Defaults to
 *   serviceCost × quantity so existing schedule/cart callers are unaffected.
 */
export const buildServiceBookingDoc = async ({
  service,
  resolvedLocation,
  schedule,
  tipAmountRupees = 0,
  customerId,
  addressId = null,
  faultProblem = null,
  quantity = 1,
  cityZoneId = null,
  districtId = null,
  baseAmountOverride = null,
}) => {
  const now = new Date();
  const baseAmount =
    baseAmountOverride !== null && baseAmountOverride !== undefined
      ? baseAmountOverride
      : (service.serviceCost || 0) * quantity;

  const snapshot = await resolveCommissionSnapshot({
    booking: { baseAmount, itemType: "service" },
    service,
    tipAmountRupees,
  });

  const bookingType = schedule.bookingType;
  const scheduledAt = schedule.scheduledAt || null;
  const autoCancelAt = computeAutoCancelAt(bookingType, scheduledAt, now);

  const doc = {
    customerId,
    serviceId: service._id,
    districtId: districtId || null,
    cityZoneId: cityZoneId || null,
    bookingType,
    baseAmount,
    financialSnapshot: snapshot,
    scheduledAt,
    timezone: schedule.timezone,
    scheduledDateLocal: schedule.scheduledDateLocal,
    scheduledTimeLocal: schedule.scheduledTimeLocal,
    faultProblem: faultProblem || null,
    locationType: resolvedLocation.locationType,
    addressSnapshot: resolvedLocation.addressSnapshot,
    address: resolvedLocation.addressSnapshot.addressLine || "Pinned Location",
    addressId: resolvedLocation.addressId || addressId || null,
    commissionPercentage: snapshot.commissionPercentage,
    commissionAmount: paiseToRupees(snapshot.commissionAmountPaise),
    technicianAmount: paiseToRupees(snapshot.technicianAmountPaise),
    gstPercentage: snapshot.gstPercentage,
    gstAmount: paiseToRupees(snapshot.gstAmountPaise),
    tipAmount: paiseToRupees(snapshot.tipAmountPaise),
    status: "pending",
    assignmentStatus: "unassigned",
    cancellationStatus: "active",
    cancellationFeeStatus: "not_collected",
    broadcastStartedAt: now,
    autoCancelAt,
    cityZoneId,
    estimatedArrivalAt: bookingType === "instant" ? new Date(now.getTime() + 30 * 60 * 1000) : null,
    etaGeneratedAt: bookingType === "instant" ? now : null,
    retryCount: 0,
    technicianRejectCount: 0,
    version: 1,
  };

  if (resolvedLocation.longitude !== null && resolvedLocation.latitude !== null) {
    doc.location = {
      type: "Point",
      coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
    };
  }

  return doc;
};

/**
 * Insert the booking + BOOKING_CREATED outbox row in the caller's transaction.
 * Caller owns commit/abort.
 *
 * @returns {{ booking: Object, traceId: String }}
 */
export const createBookingAndOutbox = async ({ doc, session }) => {
  // Generate trace ID for end-to-end tracking
  const traceId = `trc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const [booking] = await ServiceBooking.create([doc], { session });

  await BookingOutbox.create(
    [
      {
        aggregateId: booking._id,
        eventType: "booking_created",
        idempotencyKey: `booking-created:${booking._id}`,
        version: booking.version || 1,
        payload: { status: "pending", bookingType: booking.bookingType, traceId },
      },
    ],
    { session }
  );

  console.log(`[TRACE] ${traceId} BOOKING_CREATED bookingId=${booking._id}`);
  return { booking, traceId };
};

/**
 * Broadcast after commit: inline fast path + outbox worker as retry/audit.
 * Never called before the booking transaction commits.
 *
 * @returns {Promise<{count: number, outbox: boolean, traceId: String}>}
 */
export const broadcastCreatedBooking = async (bookingId, io) => {
  try {
    // Try to get traceId from outbox
    const outboxRow = await BookingOutbox.findOne({ aggregateId: bookingId, eventType: "booking_created" }).lean();
    const traceId = outboxRow?.payload?.traceId || `trc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    console.log(`[TRACE] ${traceId} MATCHING_STARTED bookingId=${bookingId}`);
    const result = await matchAndBroadcastBooking(bookingId, io, traceId);
    return { count: result?.count ?? 0, outbox: false, traceId };
  } catch (err) {
    console.warn(`[BookingService] inline broadcast failed for ${bookingId}, outbox worker will retry: ${err.message}`);
    return { count: 0, outbox: true };
  }
};

/**
 * Mark a booking's outbox row done (used by the inline fast path).
 */
export const markBookingOutboxDone = async (bookingId) => {
  await BookingOutbox.updateOne(
    { aggregateId: bookingId, eventType: "booking_created" },
    { $set: { status: "done", completedAt: new Date() } }
  );
};

/**
 * Worker-safe processor for BOOKING_CREATED rows.
 * Rechecks aggregate state before broadcasting (booking must still be pending
 * or broadcasted, and never broadcasted before — activeBroadcastVersion == 0
 * means the inline fast path didn't run).
 */
export const processBookingCreatedOutbox = async (booking) => {
  const current = await ServiceBooking.findById(booking.aggregateId)
    .select("status activeBroadcastVersion technicianId")
    .lean();

  if (!current) {
    return { status: "done", reason: "booking_missing" };
  }

  const status = normalizeBookingStatus(current.status);
  if (["cancelled", "expired", "completed"].includes(status)) {
    return { status: "done", reason: `terminal_${status}` };
  }

  if ((current.activeBroadcastVersion || 0) > 0) {
    return { status: "done", reason: "already_broadcast" };
  }

  const traceId = booking.payload?.traceId || `trc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  console.log(`[TRACE] ${traceId} OUTBOX_WORKER_CLAIMED bookingId=${booking.aggregateId}`);

  return { status: "run", traceId };
};