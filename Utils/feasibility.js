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

const DEFAULT_CITY_SPEED_KMPH = 25; // city driving average for ETA estimates
const DEFAULT_TRAVEL_BUFFER = 1.15; // +15% — deadline gate, not display ETA
const DEFAULT_JOB_GRACE_MINUTES = 15;

/* ------------------------- geometry helpers ------------------------- */

/** Great-circle distance in meters (haversine). */
export const haversineMeters = (from, to) => {
  if (!from || !to) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(to.latitude - from.latitude);
  const dLng = toRad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) *
      Math.cos(toRad(to.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** Normalize a GeoJSON point [lng, lat] or {latitude, longitude} to {latitude, longitude}. */
const toLatLng = (loc) => {
  if (!loc) return null;
  if (Array.isArray(loc.coordinates) && loc.coordinates.length === 2) {
    return { longitude: loc.coordinates[0], latitude: loc.coordinates[1] };
  }
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { latitude: lat, longitude: lng };
  }
  return null;
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
