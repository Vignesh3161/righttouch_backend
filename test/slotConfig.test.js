import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SLOT_CONFIG,
  validateSlotConfig,
} from "../Utils/slotConfig.js";
import {
  BUSINESS_TIMEZONE,
  generateScheduleDays,
  generateTimeSlots,
  getBookingSchedulePayload,
  localDateInBusinessTimezone,
  startOfBusinessDayUtc,
} from "../Utils/slots.js";

test("default slot config produces four 3-hour slots from 09:00 to 21:00", () => {
  const slots = generateTimeSlots();
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map((slot) => slot.value), ["09:00", "12:00", "15:00", "18:00"]);
  assert.deepEqual(slots.map((slot) => slot.startTime), ["09:00", "12:00", "15:00", "18:00"]);
  assert.deepEqual(slots.map((slot) => slot.endTime), ["12:00", "15:00", "18:00", "21:00"]);
  assert.equal(slots[0].label, "09:00 AM - 12:00 PM");
  assert.equal(slots[3].label, "06:00 PM - 09:00 PM");
});

test("validateSlotConfig accepts defaults and rejects invalid windows", () => {
  assert.equal(validateSlotConfig(DEFAULT_SLOT_CONFIG).valid, true);

  assert.equal(validateSlotConfig({ windowStartHour: 21, windowEndHour: 9 }).valid, false);
  assert.equal(validateSlotConfig({ slotCount: 7 }).valid, false);
  assert.equal(validateSlotConfig({ scheduleDays: 0 }).valid, false);
  assert.equal(validateSlotConfig({ scheduleDays: 31 }).valid, false);
  assert.equal(validateSlotConfig({ slotCount: 24 }).valid, false);
  assert.equal(validateSlotConfig({ slotCount: 0 }).valid, false);
});

test("validateSlotConfig supports custom whole-window splits", () => {
  const result = validateSlotConfig({
    scheduleDays: 7,
    windowStartHour: 10,
    windowEndHour: 20,
    slotCount: 2,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.config, {
    scheduleDays: 7,
    windowStartHour: 10,
    windowEndHour: 20,
    slotCount: 2,
  });
});

test("schedule days start tomorrow and span the configured count", () => {
  const now = new Date();
  const days = generateScheduleDays(now, BUSINESS_TIMEZONE);
  assert.equal(days.length, DEFAULT_SLOT_CONFIG.scheduleDays);
  assert.equal(days[0].label, "Tomorrow");
  assert.equal(days[1].label, "Day after Tomorrow");

  const todayStart = startOfBusinessDayUtc(now, BUSINESS_TIMEZONE);
  const tomorrow = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  assert.equal(days[0].fullDate, localDateInBusinessTimezone(tomorrow, BUSINESS_TIMEZONE));
  assert.equal(days[0].fullDate > localDateInBusinessTimezone(now, BUSINESS_TIMEZONE), true);
});

test("GET schedule payload returns the minimal contract", () => {
  const payload = getBookingSchedulePayload(new Date(), BUSINESS_TIMEZONE, {
    enabled: false,
    reason: "service_required",
  });

  assert.deepEqual(Object.keys(payload).sort(), ["instant", "schedule"]);
  assert.deepEqual(Object.keys(payload.instant).sort(), ["displayValue", "label"]);
  assert.deepEqual(
    Object.keys(payload.schedule).sort(),
    ["availability", "days", "timeSlots", "timezone"]
  );
  assert.deepEqual(
    Object.keys(payload.schedule.days[0]).sort(),
    ["date", "fullDate", "label", "month", "weekday"]
  );
  assert.deepEqual(
    Object.keys(payload.schedule.timeSlots[0]).sort(),
    ["endTime", "label", "startTime", "value"]
  );
  assert.equal(payload.instant.displayValue, "In 30 mins");
  assert.equal(payload.schedule.availability.reason, "service_required");
});
