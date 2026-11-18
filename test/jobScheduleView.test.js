import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScheduledJobCalendar,
  resolveCalendarRange,
} from "../Utils/jobScheduleView.js";

const makeJob = (id, iso, extra = {}) => ({
  jobId: id,
  scheduledAt: new Date(iso),
  slotValue: null,
  slotLabel: null,
  scheduledDateLocal: null,
  scheduledTimeLocal: null,
  status: "accepted",
  ...extra,
});

test("jobs are grouped by business day and configured slot", () => {
  const fromDate = "2026-11-19";
  const toDate = "2026-11-19";
  const calendar = buildScheduledJobCalendar({
    fromDate,
    toDate,
    jobs: [
      makeJob("morning", "2026-11-19T03:30:00.000Z"),
      makeJob("afternoon", "2026-11-19T07:00:00.000Z"),
    ],
  });

  assert.equal(calendar.timezone, "Asia/Kolkata");
  assert.equal(calendar.totalJobs, 2);
  assert.equal(calendar.days.length, 1);

  const day = calendar.days[0];
  assert.equal(day.fullDate, fromDate);
  assert.equal(day.jobCount, 2);
  assert.equal(day.slots.length, 4);

  const morning = day.slots.find((slot) => slot.value === "09:00");
  const afternoon = day.slots.find((slot) => slot.value === "12:00");
  assert.equal(morning.jobCount, 1);
  assert.equal(morning.jobs[0].jobId, "morning");
  assert.equal(afternoon.jobCount, 1);
  assert.equal(afternoon.jobs[0].jobId, "afternoon");
});

test("legacy timestamps map to the containing slot", () => {
  const calendar = buildScheduledJobCalendar({
    fromDate: "2026-11-19",
    toDate: "2026-11-19",
    jobs: [makeJob("legacy", "2026-11-19T04:17:00.000Z")],
  });

  const slot = calendar.days[0].slots.find((entry) => entry.value === "09:00");
  assert.equal(slot.jobCount, 1);
  assert.equal(slot.jobs[0].jobId, "legacy");
});

test("includeEmptySlots false hides slots without jobs", () => {
  const calendar = buildScheduledJobCalendar({
    fromDate: "2026-11-19",
    toDate: "2026-11-19",
    jobs: [makeJob("morning", "2026-11-19T03:30:00.000Z")],
    includeEmptySlots: false,
  });

  assert.equal(calendar.days[0].slots.length, 1);
  assert.equal(calendar.days[0].slots[0].value, "09:00");
});

test("calendar range defaults to today through the configured window", () => {
  const now = new Date("2026-11-18T05:00:00.000Z");
  const range = resolveCalendarRange({ now, defaultDays: 6 });
  assert.equal(range.error, undefined);
  assert.equal(range.fromDate, "2026-11-18");
  assert.equal(range.toDate, "2026-11-23");
  assert.equal(range.dayCount, 6);
});

test("calendar range accepts a single date and rejects invalid ranges", () => {
  const single = resolveCalendarRange({ date: "2026-11-20" });
  assert.equal(single.fromDate, "2026-11-20");
  assert.equal(single.toDate, "2026-11-20");

  const invalid = resolveCalendarRange({ fromDate: "2026-11-22", toDate: "2026-11-20" });
  assert.ok(invalid.error);

  const tooLong = resolveCalendarRange({
    fromDate: "2026-11-01",
    toDate: "2026-12-31",
    maxDays: 31,
  });
  assert.ok(tooLong.error);
});
