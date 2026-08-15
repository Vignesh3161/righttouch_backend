/**
 * 🧪 UNIT TESTS — Canonical statuses, slot engine, creation pipeline helpers.
 * Run: node --test Tests/bookingEngine.test.js
 * (pure functions only — no DB required)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBookingStatus,
  canTransition,
  isTerminalBookingStatus,
  CANONICAL_BOOKING_STATUSES,
} from "../Utils/bookingStatus.js";

import {
  generateTimeSlots,
  generateScheduleDays,
  validateSlot,
  validateScheduledAtUtc,
  localDateTimeToUtc,
  localDateInBusinessTimezone,
  scheduleBookingWindow,
  BUSINESS_TIMEZONE,
} from "../Utils/slots.js";

import { computeAutoCancelAt } from "../Utils/bookingService.js";

// ── 1. Canonical vocabulary ──────────────────────────────────────────────
test("legacy statuses normalize to canonical", () => {
  assert.equal(normalizeBookingStatus("ACCEPTED"), "accepted");
  assert.equal(normalizeBookingStatus("SEARCHING"), "broadcasted");
  assert.equal(normalizeBookingStatus("requested"), "pending");
  assert.equal(normalizeBookingStatus("accepted"), "accepted");
  assert.equal(normalizeBookingStatus("pending"), "pending");
  assert.equal(normalizeBookingStatus(null), null);
});

test("transition table matches the spec", () => {
  assert.equal(canTransition("pending", "broadcasted"), true);
  assert.equal(canTransition("pending", "cancelled"), true);
  assert.equal(canTransition("pending", "expired"), true);
  assert.equal(canTransition("pending", "accepted"), false); // only via broadcasted
  assert.equal(canTransition("broadcasted", "accepted"), true);
  assert.equal(canTransition("accepted", "on_the_way"), true);
  assert.equal(canTransition("accepted", "cancelled"), true);
  assert.equal(canTransition("on_the_way", "reached"), true);
  assert.equal(canTransition("reached", "in_progress"), true);
  assert.equal(canTransition("in_progress", "completed"), true);
  assert.equal(canTransition("completed", "on_the_way"), false);
  assert.equal(canTransition("ACCEPTED", "on_the_way"), true); // legacy input
  assert.equal(canTransition("expired", "accepted"), false);
  assert.equal(canTransition("cancelled", "pending"), false);
});

test("terminal statuses", () => {
  assert.equal(isTerminalBookingStatus("completed"), true);
  assert.equal(isTerminalBookingStatus("expired"), true);
  assert.equal(isTerminalBookingStatus("cancelled"), true);
  assert.equal(isTerminalBookingStatus("accepted"), false);
  assert.equal(isTerminalBookingStatus("ACCEPTED"), false);
});

test("canonical list is unique and complete", () => {
  assert.equal(new Set(CANONICAL_BOOKING_STATUSES).size, CANONICAL_BOOKING_STATUSES.length);
  assert.equal(CANONICAL_BOOKING_STATUSES.length, 9);
});

// ── 2. Slot engine ───────────────────────────────────────────────────────
test("slots run 09:00 → 20:30, 30-min intervals, 21:00 excluded", () => {
  const slots = generateTimeSlots();
  assert.equal(slots[0].value, "09:00");
  assert.equal(slots[1].value, "09:30");
  assert.equal(slots.at(-1).value, "20:30");
  assert.equal(slots.filter((s) => s.value.startsWith("21:")).length, 0);
  // 12 hours × 2 = 24 slots
  assert.equal(slots.length, 24);
});

test("schedule days are tomorrow + day-after-tomorrow in business timezone", () => {
  const days = generateScheduleDays();
  assert.equal(days.length, 2);
  const todayLocal = localDateInBusinessTimezone(new Date());
  const expectedTomorrow = localDateInBusinessTimezone(
    new Date(new Date(todayLocal + "T00:00:00Z").getTime() + 24 * 3600 * 1000)
  );
  assert.equal(days[0].fullDate, expectedTomorrow);
});

test("localDateTimeToUtc round-trips business timezone (Asia/Kolkata +05:30)", () => {
  const utc = localDateTimeToUtc("2026-08-15", "09:30", "Asia/Kolkata");
  assert.ok(utc instanceof Date);
  // 09:30 IST == 04:00 UTC
  assert.equal(utc.toISOString(), "2026-08-15T04:00:00.000Z");
});

test("validateSlot accepts a valid slot", () => {
  // Fixed base so the test is deterministic regardless of when it runs:
  // 2026-08-14 10:00 UTC == 15:30 IST → tomorrow = 2026-08-15 in IST.
  const base = new Date("2026-08-14T10:00:00Z");
  const { from } = scheduleBookingWindow(base);
  const tomorrowStr = localDateInBusinessTimezone(from);
  const result = validateSlot(tomorrowStr, "10:30", { now: base });
  assert.equal(result.valid, true);
  assert.ok(result.scheduledAt instanceof Date);
});

test("validateSlot rejects invalid times and out-of-window dates", () => {
  assert.equal(validateSlot("2026-08-15", "08:30").valid, false); // before 09:00
  assert.equal(validateSlot("2026-08-15", "21:30").valid, false); // after 20:30
  assert.equal(validateSlot("2026-08-15", "10:15").valid, false); // not 30-min step

  const todayStr = localDateInBusinessTimezone(new Date());
  assert.equal(validateSlot(todayStr, "10:00").valid, false); // today — not allowed
});

test("validateSlot enforces minimum lead time on real UTC time", () => {
  const base = new Date("2026-08-14T10:00:00Z");
  const { from } = scheduleBookingWindow(base);
  const tomorrowStr = localDateInBusinessTimezone(from);
  // Now = 20 minutes before the slot → must be rejected (min lead 30 min).
  const result = validateSlot(tomorrowStr, "09:00", {
    now: new Date(new Date(tomorrowStr + "T09:00:00Z").getTime() - 20 * 60 * 1000),
  });
  assert.equal(result.valid, false);
});

test("validateScheduledAtUtc handles ISO scheduledAt", () => {
  const base = new Date("2026-08-14T10:00:00Z");
  const { from } = scheduleBookingWindow(base);
  const r = validateScheduledAtUtc(new Date(from.getTime() + 10 * 3600 * 1000), { now: base });
  assert.equal(r.valid, true);
  assert.equal(typeof r.scheduledTimeLocal, "string");
  assert.equal(r.timezone, BUSINESS_TIMEZONE);
});

// ── 3. Creation pipeline helpers ─────────────────────────────────────────
test("autoCancelAt: instant = now + 1h", () => {
  const now = new Date("2026-08-14T10:00:00Z");
  const at = computeAutoCancelAt("instant", null, now);
  assert.equal(at.getTime(), now.getTime() + 60 * 60 * 1000);
});

test("autoCancelAt: schedule = slot − 5h", () => {
  const now = new Date("2026-08-14T10:00:00Z");
  const slot = new Date("2026-08-15T09:00:00Z");
  const at = computeAutoCancelAt("schedule", slot, now);
  assert.equal(at.getTime(), slot.getTime() - 5 * 3600 * 1000);
});

test("autoCancelAt: schedule too close → now + 5min", () => {
  const now = new Date("2026-08-14T10:00:00Z");
  const slot = new Date("2026-08-14T12:00:00Z"); // −5h = 07:00 < now
  const at = computeAutoCancelAt("schedule", slot, now);
  assert.equal(at.getTime(), now.getTime() + 5 * 60 * 1000);
});