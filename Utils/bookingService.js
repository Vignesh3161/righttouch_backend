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

import crypto from "crypto";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import BookingOutbox from "../Schemas/BookingOutbox.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import { resolveServiceZoneFromCoordinates } from "./resolveZoneFromCoordinates.js";
import { resolveCommissionSnapshot } from "./commission.js";
import { paiseToRupees } from "./money.js";
import { matchAndBroadcastBooking } from "./technicianMatching.js";
import { validateSlot, BUSINESS_TIMEZONE, localDateInBusinessTimezone, formatInBusinessTimezone } from "./slots.js";
import { isBookingPastAutoCancel, normalizeBookingStatus } from "./bookingStatus.js";
import { computeDispatchEligibleAt } from "./schedulingConfig.js";
import { assertServiceFitsSlot } from "../Services/slotAvailabilityService.js";

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
  // Strict: an address without resolvable coordinates can never pass geo gates.
  const latNum = Number(latitude);
  const lngNum = Number(longitude);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return {
      ok: false,
      zoneId: null,
      districtId: null,
      error: FRIENDLY,
      code: "SERVICE_NOT_AVAILABLE",
      reason: "LOCATION_REQUIRED",
    };
  }
  // Overlapping zones are allowed. Resolve the zone by the requested service
  // so a point covered by multiple service-specific zones does not get an
  // arbitrary first-zone answer.
  const resolved = await resolveServiceZoneFromCoordinates(
    service?._id,
    latNum,
    lngNum,
    { session }
  );

  if (resolved.error) {
    return {
      ok: false,
      zoneId: resolved.zone?._id || null,
      districtId: resolved.district?._id || null,
      error: FRIENDLY,
      code: "SERVICE_NOT_AVAILABLE",
      reason: resolved.reason || resolved.error,
    };
  }

  const { district, zone } = resolved;
  // FINAL RULE: address must resolve to BOTH District AND Zone.
  // No zone polygon → block (no district fallback for booking).
  if (!zone?._id || !district?._id) {
    return {
      ok: false,
      zoneId: zone?._id || null,
      districtId: district?._id || null,
      error: FRIENDLY,
      code: "SERVICE_NOT_AVAILABLE",
      reason: !zone?._id ? "ZONE_REQUIRED" : "DISTRICT_REQUIRED",
    };
  }
  // Parent-link guard: the resolved zone must belong to the resolved
  // district. Without this, booking stores district A while broadcast
  // re-resolves district B and availability/broadcast mismatches (count 0).
  if (String(zone.operationalCityId) !== String(district._id)) {
    return {
      ok: false,
      zoneId: zone?._id || null,
      districtId: district?._id || null,
      error: FRIENDLY,
      code: "SERVICE_NOT_AVAILABLE",
      reason: "ZONE_DISTRICT_MISMATCH",
    };
  }

  const avail = resolved.availability;
  if (!avail?.available) {
    return {
      ok: false,
      zoneId: zone?._id || null,
      districtId: district._id,
      error: FRIENDLY,
      code: "SERVICE_NOT_AVAILABLE",
      reason: avail?.reason || "SERVICE_NOT_AVAILABLE",
    };
  }

  return {
    ok: true,
    zoneId: zone._id,
    districtId: district._id,
    matchingZoneIds: (resolved.matchingZones || [zone]).map((entry) => entry._id),
  };
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
  const requestedType = String(body?.bookingType || "").toLowerCase();
  const hasScheduleInput = Boolean(body?.scheduledDate && body?.scheduledTime);
  const bookingType =
    requestedType === "schedule" || requestedType === "scheduled" || hasScheduleInput
      ? "schedule"
      : "instant";

  if (bookingType === "instant") {
    return {
      bookingType,
      scheduledAt: null,
      slotKey: null,
      slotValue: null,
      slotLabel: null,
      slotStartAt: null,
      slotEndAt: null,
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
    scheduledAt: validation.slot?.slotStartAt || validation.scheduledAt,
    slotKey: validation.slot?.slotKey || null,
    slotValue: validation.slot?.slotValue || scheduledTime,
    slotLabel: validation.slot?.slotLabel || null,
    slotStartAt: validation.slot?.slotStartAt || validation.scheduledAt,
    slotEndAt: validation.slot?.slotEndAt || null,
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
  if (bookingType === "schedule") {
    assertServiceFitsSlot(service.durationMinutes || 60);
  }
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
    slotKey: schedule.slotKey || null,
    slotValue: schedule.slotValue || null,
    slotLabel: schedule.slotLabel || null,
    slotStartAt: schedule.slotStartAt || null,
    slotEndAt: schedule.slotEndAt || null,
    estimatedDurationMinutes: service.durationMinutes || 60,
    dispatchEligibleAt: computeDispatchEligibleAt(bookingType, scheduledAt, now),
    timezone: schedule.timezone,
    scheduledDateLocal: schedule.scheduledDateLocal,
    scheduledTimeLocal: schedule.scheduledTimeLocal,
    customerStatusLabel: bookingType === "schedule" ? "Awaiting technician" : null,
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

const AUTO_IDEMPOTENCY_WINDOW_MS = Math.max(
  1000,
  Number(process.env.BOOKING_IDEMPOTENCY_WINDOW_SECONDS) || 30
) * 1000;

export const resolveBookingIdempotencyKey = ({
  req,
  scope,
  customerId,
  suffix = null,
  fingerprint = null,
  windowMs = AUTO_IDEMPOTENCY_WINDOW_MS,
} = {}) => {
  if (!scope || !customerId) return null;

  const suffixPart = suffix ? `:${suffix}` : "";
  const rawKey =
    req?.get?.("Idempotency-Key") ??
    req?.headers?.["idempotency-key"] ??
    req?.body?.idempotencyKey ??
    null;

  if (rawKey !== null && rawKey !== undefined && String(rawKey).trim()) {
    const key = String(rawKey).trim();
    if (key.length > 180) {
      throw Object.assign(
        new Error("Idempotency-Key must be 180 characters or fewer"),
        { statusCode: 400 }
      );
    }
    return `${scope}:${customerId}:${key}${suffixPart}`;
  }

  if (!fingerprint) return null;
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(fingerprint))
    .digest("hex")
    .slice(0, 32);
  const bucket = Math.floor(Date.now() / windowMs);
  return `${scope}:${customerId}:auto:${hash}${suffixPart}:${bucket}`;
};

export const findBookingByIdempotencyKey = async (idempotencyKey, session = null) => {
  if (!idempotencyKey) return null;
  let query = ServiceBooking.findOne({ idempotencyKey });
  if (session) query = query.session(session);
  return query;
};

export const findBookingByIdempotencyKeyWithRetry = async (
  idempotencyKey,
  { attempts = 4, delayMs = 50 } = {}
) => {
  if (!idempotencyKey) return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const booking = await findBookingByIdempotencyKey(idempotencyKey);
    if (booking) return booking;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
};

export const isDuplicateKeyError = (error) =>
  Boolean(
    error &&
      (error.code === 11000 ||
        error.code === 11001 ||
        /E11000/.test(String(error.message || "")))
  );

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
    .select("status activeBroadcastVersion technicianId autoCancelAt")
    .lean();

  if (!current) {
    return { status: "done", reason: "booking_missing" };
  }

  const status = normalizeBookingStatus(current.status);
  if (["cancelled", "expired", "completed"].includes(status)) {
    return { status: "done", reason: `terminal_${status}` };
  }
  if (!["pending", "broadcasted"].includes(status)) {
    return { status: "done", reason: `not_dispatchable_${status}` };
  }

  if (isBookingPastAutoCancel(current)) {
    return { status: "done", reason: "auto_cancel_deadline_passed" };
  }

  if ((current.activeBroadcastVersion || 0) > 0) {
    return { status: "done", reason: "already_broadcast" };
  }

  const traceId = booking.payload?.traceId || `trc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  console.log(`[TRACE] ${traceId} OUTBOX_WORKER_CLAIMED bookingId=${booking.aggregateId}`);

  return { status: "run", traceId };
};