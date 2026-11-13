/**
 * ⏱ FEASIBILITY ENGINE — "can this technician be at location X by time T?"
 *
 * One pure function, two callers (instant-job offer filtering and scheduled-job
 * conflict checks). Everything below is deterministic math on in-memory data —
 * zero DB access, safe to run per-candidate inside hot matching loops.
 *
 * ── Forward pass ────────────────────────────────────────────────────────────
 * Walk the technician's committed queue (active + accepted jobs, in order),
 * adding travel + job duration per stop, then project the final arrival time
 * at the target location and compare against the required deadline.
 *
 * ── Backward pass ───────────────────────────────────────────────────────────
 * computeLatestArrival() derives the single deadline number for a scheduled
 * booking (scheduledAt - grace). Stored once per booking; travel time is NOT
 * baked in here because the technician's origin is only known at offer time.
 */

import {
  FEASIBILITY_CITY_SPEED_KMPH,
  FEASIBILITY_TRAVEL_BUFFER,
  FEASIBILITY_GRACE_MINUTES,
} from "./schedulingConfig.js";

const DEFAULT_CITY_SPEED_KMPH = FEASIBILITY_CITY_SPEED_KMPH;
const DEFAULT_TRAVEL_BUFFER = FEASIBILITY_TRAVEL_BUFFER;
const DEFAULT_JOB_GRACE_MINUTES = FEASIBILITY_GRACE_MINUTES;

/** Normalize a GeoJSON point [lng, lat], GeoJSON object, or {latitude, longitude} to {latitude, longitude}. */
export const toLatLng = (loc) => {
  if (!loc) return null;
  if (Array.isArray(loc)) {
    if (loc.length >= 2 && Number.isFinite(Number(loc[0])) && Number.isFinite(Number(loc[1]))) {
      // GeoJSON standard: [longitude, latitude]
      return { longitude: Number(loc[0]), latitude: Number(loc[1]) };
    }
    return null;
  }
  if (loc.type === "Point" && Array.isArray(loc.coordinates) && loc.coordinates.length >= 2) {
    return { longitude: Number(loc.coordinates[0]), latitude: Number(loc.coordinates[1]) };
  }
  if (Array.isArray(loc.coordinates) && loc.coordinates.length >= 2) {
    return { longitude: Number(loc.coordinates[0]), latitude: Number(loc.coordinates[1]) };
  }
  const lat = Number(loc.latitude ?? loc.lat);
  const lng = Number(loc.longitude ?? loc.lng ?? loc.lon);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { latitude: lat, longitude: lng };
  }
  return null;
};

/** Great-circle distance in meters (haversine). Safely accepts any GeoJSON or coordinate format. */
export const haversineMeters = (from, to) => {
  const a = toLatLng(from);
  const b = toLatLng(to);
  if (!a || !b) return null;

  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      sinDLng * sinDLng;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/* ------------------------- travel estimation ------------------------- */

/**
 * Estimate travel time (minutes) between two points.
 * Reuses a simple speed-model (same class of math as the geo matcher);
 * the buffer constant makes this deliberately conservative — it gates a
 * deadline, not a display ETA.
 */
export const estimateTravelMinutes = (
  from,
  to,
  { speedKmph = DEFAULT_CITY_SPEED_KMPH, buffer = DEFAULT_TRAVEL_BUFFER } = {}
) => {
  const a = toLatLng(from);
  const b = toLatLng(to);
  const meters = haversineMeters(a, b);
  if (meters == null) return null;
  const rawMinutes = meters / 1000 / speedKmph * 60;
  return Math.ceil(rawMinutes * buffer);
};

/**
 * The deadline number for a scheduled booking: when the technician must
 * ARRIVE at the customer's location (slot minus grace period).
 */
export const computeLatestArrival = (
  scheduledAt,
  graceMinutes = DEFAULT_JOB_GRACE_MINUTES
) => {
  const slot = new Date(scheduledAt).getTime();
  if (!Number.isFinite(slot)) return null;
  return new Date(slot - graceMinutes * 60 * 1000);
};

/* ------------------------- the engine ------------------------- */

/**
 * Forward-pass feasibility check.
 *
 * @param {object}  opts
 * @param {object}  opts.technicianLocation     current tech position (GeoJSON Point or lat/lng)
 * @param {Array}   opts.committedQueue         jobs already locked in, in execution order:
 *                                              [{ location, estimatedDurationMinutes }] —
 *                                              use -1 duration for "unknown" (counts as 0)
 * @param {object}  [opts.candidateJob]         optional job being offered now; prepended to the
 *                                              queue if it happens before the committed jobs
 * @param {object}  opts.targetLocation         the location the tech must reach (usually the
 *                                              next scheduled booking's location)
 * @param {Date|number} opts.requiredArrivalTime deadline (e.g. computeLatestArrival(scheduledAt))
 * @param {object}  [opts.travel]               { speedKmph, buffer } overrides
 *
 * @returns {{ feasible: boolean, projectedArrival: Date|null, slackMinutes: number|null, reason: string }}
 *
 * ── Usage ──
 * Instant job offered while a scheduled booking is pending:
 *   canArriveBy({
 *     technicianLocation, committedQueue: [scheduledBooking],
 *     candidateJob: instantJob,
 *     targetLocation: scheduledBooking.location,
 *     requiredArrivalTime: computeLatestArrival(scheduledBooking.scheduledAt),
 *   })
 *
 * Scheduled-job conflict (fixed appointments, no travel needed):
 *   overlap windows directly — see findOverlappingAcceptedSchedules in the
 *   dispatch utils; the engine is not involved.
 */
export const canArriveBy = ({
  technicianLocation,
  committedQueue = [],
  candidateJob = null,
  targetLocation,
  requiredArrivalTime,
  travel = {},
}) => {
  const deadline = new Date(requiredArrivalTime).getTime();
  if (!Number.isFinite(deadline)) {
    // No hard deadline → nothing can make this infeasible.
    return { feasible: true, projectedArrival: null, slackMinutes: null, reason: "no_deadline" };
  }

  const now = Date.now();
  let cursor = now;
  let location = technicianLocation;

  const ordered = candidateJob ? [candidateJob, ...committedQueue] : committedQueue;

  for (const job of ordered) {
    const travelMin = estimateTravelMinutes(location, job.location, travel);
    if (travelMin == null) {
      return { feasible: false, projectedArrival: null, slackMinutes: null, reason: "missing_location" };
    }
    cursor += travelMin * 60 * 1000;

    const dur = Number(job.estimatedDurationMinutes);
    if (Number.isFinite(dur) && dur > 0) {
      cursor += dur * 60 * 1000;
    }
    location = job.location;
  }

  const finalTravelMin = estimateTravelMinutes(location, targetLocation, travel);
  if (finalTravelMin == null) {
    return { feasible: false, projectedArrival: null, slackMinutes: null, reason: "missing_target_location" };
  }
  cursor += finalTravelMin * 60 * 1000;

  const projectedArrival = new Date(cursor);
  const slackMinutes = (deadline - cursor) / 60000;

  return {
    feasible: cursor <= deadline,
    projectedArrival,
    slackMinutes: Math.round(slackMinutes * 10) / 10,
    reason: cursor <= deadline ? "feasible" : "arrives_late",
  };
};

/**
 * Scheduled-chain feasibility: can the technician serve the candidate
 * appointment plus every already-accepted scheduled job without overlapping
 * travel/service windows?
 *
 * Existing accepted appointments and the candidate are sorted by start time,
 * then walked with the same travel model used for instant jobs. The grace
 * window is the latest acceptable arrival at each appointment.
 */
export const scheduleChainFeasible = ({
  technicianLocation,
  candidateJob,
  committedQueue = [],
  activeJob = null,
  travel = {},
  graceMinutes = DEFAULT_JOB_GRACE_MINUTES,
  now = new Date(),
}) => {
  const committed = [...committedQueue];
  if (activeJob?._id && !committed.some((job) => String(job._id) === String(activeJob._id))) {
    committed.push(activeJob);
  }
  // Four-slot rule: a technician can hold at most one scheduled job per slot.
  const candidateSlotKey = candidateJob?.slotKey || null;
  if (candidateSlotKey) {
    const conflict = committed.find(
      (job) => job?.slotKey && String(job.slotKey) === String(candidateSlotKey)
    );
    if (conflict) {
      return {
        feasible: false,
        projectedArrival: null,
        slackMinutes: null,
        reason: "slot_conflict",
      };
    }
  }

  const jobs = [...committed, candidateJob]
    .filter((job) => job?.scheduledAt)
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  let cursor = new Date(now).getTime();
  let location = technicianLocation;
  const travelOpts = {
    speedKmph: DEFAULT_CITY_SPEED_KMPH,
    buffer: DEFAULT_TRAVEL_BUFFER,
    ...travel,
  };

  // An active instant job occupies the technician before any future slot.
  if (activeJob?.bookingType === "instant" && activeJob.location) {
    const activeTravelMin = estimateTravelMinutes(location, activeJob.location, travelOpts);
    if (activeTravelMin != null) {
      cursor += activeTravelMin * 60 * 1000;
      const activeDuration = Number(activeJob.estimatedDurationMinutes);
      cursor += (Number.isFinite(activeDuration) && activeDuration > 0 ? activeDuration : 60) * 60 * 1000;
      location = activeJob.location;
    }
  }

  const nowMs = new Date(now).getTime();
  for (const job of jobs) {
    const travelMin = estimateTravelMinutes(location, job.location, travelOpts);
    if (travelMin == null) {
      return { feasible: false, projectedArrival: null, slackMinutes: null, reason: "missing_location" };
    }
    const start = new Date(job.scheduledAt).getTime();
    if (!Number.isFinite(start)) continue;

    const duration = Number(job.estimatedDurationMinutes);
    const durationMs = (Number.isFinite(duration) && duration > 0 ? duration : 60) * 60 * 1000;

    // Jobs already in progress (or past their slot) are committed work: they
    // occupy the technician from now for their remaining duration. Applying
    // the arrival deadline to them would incorrectly reject every new offer.
    if (start <= nowMs) {
      cursor += travelMin * 60 * 1000 + durationMs;
      location = job.location;
      continue;
    }

    const earliestArrival = cursor + travelMin * 60 * 1000;
    const latestArrival = start + graceMinutes * 60 * 1000;
    if (earliestArrival > latestArrival) {
      return {
        feasible: false,
        projectedArrival: new Date(earliestArrival),
        slackMinutes: Math.round(((latestArrival - earliestArrival) / 60000) * 10) / 10,
        reason: "schedule_travel_conflict",
      };
    }

    const serviceStart = Math.max(earliestArrival, start);
    cursor = serviceStart + durationMs;
    location = job.location;
  }

  return {
    feasible: true,
    projectedArrival: new Date(cursor),
    slackMinutes: null,
    reason: "schedule_chain_feasible",
  };
};
