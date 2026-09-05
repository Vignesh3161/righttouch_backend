/**
 * 🏷 CANONICAL BOOKING STATUS — single public state machine.
 *
 * These are the ONLY statuses business logic may read/write. Legacy values
 * (ACCEPTED, SEARCHING, requested, "scheduled") are normalized to canonical
 * values at read and write time — never used in queries or comparisons.
 *
 * Canonical lifecycle:
 *   pending → broadcasted → accepted → on_the_way → reached → in_progress → completed
 *   pending → cancelled | expired
 *   broadcasted → cancelled | expired
 *   accepted → on_the_way | cancelled
 *   on_the_way → reached | cancelled
 *   reached → in_progress | cancelled
 *   in_progress → completed
 *   completed / expired / cancelled → terminal (for execution)
 */

export const CANONICAL_BOOKING_STATUSES = [
  "pending",
  "broadcasted",
  "accepted",
  "on_the_way",
  "reached",
  "in_progress",
  "completed",
  "expired",
  "cancelled",
];

const LEGACY_TO_CANONICAL = {
  ACCEPTED: "accepted",
  SEARCHING: "broadcasted",
  requested: "pending",
  scheduled: "schedule",
};

/**
 * Normalize any stored/legacy status to the canonical value.
 * Unknown values pass through (defensive — schema enum still allows legacy
 * values during the migration window).
 * @param {string|null|undefined} status
 * @returns {string|null}
 */
export const normalizeBookingStatus = (status) => {
  if (status === null || status === undefined) return null;
  if (typeof status !== "string") return status;
  if (CANONICAL_BOOKING_STATUSES.includes(status)) return status;
  return LEGACY_TO_CANONICAL[status] || status;
};

export const isCanonicalBookingStatus = (status) =>
  CANONICAL_BOOKING_STATUSES.includes(status);

export const isTerminalBookingStatus = (status) =>
  ["completed", "expired", "cancelled"].includes(normalizeBookingStatus(status));

/**
 * Explicit transition table (normalized).
 * Maps current status → set of allowed next statuses.
 */
export const BOOKING_TRANSITIONS = {
  pending: ["broadcasted", "cancelled", "expired"],
  broadcasted: ["accepted", "cancelled", "expired"],
  accepted: ["on_the_way", "cancelled"],
  on_the_way: ["reached", "cancelled"],
  reached: ["in_progress", "cancelled"],
  in_progress: ["completed"],
  completed: [],
  expired: [],
  cancelled: [],
};

/**
 * @returns {boolean} true if moving from `from` to `to` is allowed.
 */
export const canTransition = (from, to) => {
  const f = normalizeBookingStatus(from);
  const t = normalizeBookingStatus(to);
  return Boolean(BOOKING_TRANSITIONS[f]?.includes(t));
};

// ── Assignment / payment / settlement / cancellation vocabularies ──────────

export const ASSIGNMENT_STATUSES = ["unassigned", "broadcasted", "assigned", "released"];

export const PAYMENT_STATUSES = [
  "pending",
  "order_created",
  "success",
  "failed",
  "refunded",
  "partially_refunded",
];

export const SETTLEMENT_STATUSES = ["pending", "eligible", "settled", "blocked", "reversed"];

export const CANCELLATION_STATUSES = ["active", "customer_cancelled", "technician_cancelled", "system_cancelled"];

export const CANCELLATION_FEE_STATUSES = ["not_collected", "collected", "waived", "disputed"];
