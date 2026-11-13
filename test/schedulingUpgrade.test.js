import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  computeDispatchEligibleAt,
  isDispatchWindowOpen,
  isScheduledQuietHours,
  nextQuietHoursEnd,
} from "../Utils/schedulingConfig.js";
import { scheduleChainFeasible } from "../Utils/feasibility.js";
import {
  evaluateTechnicianEligibility,
  getTechnicianOrigin,
} from "../Services/technicianEligibilityService.js";

const point = (longitude, latitude) => ({
  type: "Point",
  coordinates: [longitude, latitude],
});

const districtId = new mongoose.Types.ObjectId();
const serviceId = new mongoose.Types.ObjectId();

const makeTechnician = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  workStatus: "approved",
  profileComplete: true,
  trainingCompleted: true,
  availability: { isOnline: false },
  skills: [{ serviceId }],
  enabledDistrictIds: [districtId],
  allowedCityIds: [],
  enabledCityZoneIds: [],
  serviceRadiusKm: 100,
  location: point(77.0, 11.0),
  locationUpdatedAt: new Date(),
  serviceBaseLocation: point(77.0, 11.0),
  ...overrides,
});

const makeScheduledBooking = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  bookingType: "schedule",
  status: "pending",
  serviceId,
  districtId,
  cityZoneId: null,
  location: point(77.01, 11.01),
  scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  estimatedDurationMinutes: 60,
  ...overrides,
});

const eligibilityContext = {
  technicianKyc: { verificationStatus: "approved", bankVerified: true },
  serviceAvailability: { available: true },
  jobDistrictId: String(districtId),
  jobZoneId: null,
  currentDistrictCheck: { match: true, currentDistrictId: String(districtId) },
  currentZoneCheck: { match: true, currentZoneId: null },
};

test("scheduled dispatch is immediate regardless of appointment time", () => {
  const now = new Date("2026-11-03T00:00:00.000Z");
  const scheduledAt = new Date("2026-11-05T00:00:00.000Z");
  const eligibleAt = computeDispatchEligibleAt("schedule", scheduledAt, now);
  assert.equal(eligibleAt.toISOString(), now.toISOString());
  assert.equal(isDispatchWindowOpen({ bookingType: "schedule", dispatchEligibleAt: eligibleAt }, now), true);
  assert.equal(isDispatchWindowOpen({ bookingType: "instant" }, now), true);
});

test("scheduled chain rejects a second job in the same slot", () => {
  const location = point(77.0, 11.0);
  const result = scheduleChainFeasible({
    technicianLocation: location,
    candidateJob: {
      scheduledAt: new Date("2026-11-04T09:00:00.000Z"),
      slotKey: "2026-11-04|09:00",
      location,
      estimatedDurationMinutes: 60,
    },
    committedQueue: [{
      scheduledAt: new Date("2026-11-04T09:00:00.000Z"),
      slotKey: "2026-11-04|09:00",
      location,
      estimatedDurationMinutes: 60,
    }],
    now: new Date("2026-11-04T08:00:00.000Z"),
  });
  assert.equal(result.feasible, false);
  assert.equal(result.reason, "slot_conflict");
});

test("quiet hours are evaluated in the business timezone", () => {
  assert.equal(isScheduledQuietHours(new Date("2026-11-03T17:30:00.000Z")), true); // 23:00 IST
  assert.equal(isScheduledQuietHours(new Date("2026-11-03T03:00:00.000Z")), false); // 08:30 IST
  const end = nextQuietHoursEnd(new Date("2026-11-03T17:30:00.000Z"));
  assert.equal(end.toISOString(), "2026-11-04T02:30:00.000Z"); // 08:00 IST next day
});

test("scheduled chain rejects overlapping service windows", () => {
  const location = point(77.0, 11.0);
  const candidate = {
    scheduledAt: new Date("2026-11-04T10:30:00.000Z"),
    location,
    estimatedDurationMinutes: 60,
  };
  const existing = {
    scheduledAt: new Date("2026-11-04T10:00:00.000Z"),
    location,
    estimatedDurationMinutes: 60,
  };
  const result = scheduleChainFeasible({
    technicianLocation: location,
    candidateJob: candidate,
    committedQueue: [existing],
    now: new Date("2026-11-04T08:00:00.000Z"),
  });
  assert.equal(result.feasible, false);
  assert.equal(result.reason, "schedule_travel_conflict");
});

test("scheduled chain allows back-to-back appointments at the same location", () => {
  const location = point(77.0, 11.0);
  const result = scheduleChainFeasible({
    technicianLocation: location,
    candidateJob: {
      scheduledAt: new Date("2026-11-04T11:00:00.000Z"),
      location,
      estimatedDurationMinutes: 60,
    },
    committedQueue: [{
      scheduledAt: new Date("2026-11-04T10:00:00.000Z"),
      location,
      estimatedDurationMinutes: 60,
    }],
    now: new Date("2026-11-04T08:00:00.000Z"),
  });
  assert.equal(result.feasible, true);
});

test("scheduled chain treats an in-progress job as committed work", () => {
  const location = point(77.0, 11.0);
  const now = new Date("2026-11-04T10:30:00.000Z");
  const activeJob = {
    _id: new mongoose.Types.ObjectId(),
    bookingType: "schedule",
    scheduledAt: new Date("2026-11-04T10:00:00.000Z"),
    location,
    estimatedDurationMinutes: 60,
  };
  const blocked = scheduleChainFeasible({
    technicianLocation: location,
    candidateJob: {
      scheduledAt: new Date("2026-11-04T11:00:00.000Z"),
      location,
      estimatedDurationMinutes: 60,
    },
    activeJob,
    now,
  });
  assert.equal(blocked.feasible, false);

  const feasible = scheduleChainFeasible({
    technicianLocation: location,
    candidateJob: {
      scheduledAt: new Date("2026-11-04T12:00:00.000Z"),
      location,
      estimatedDurationMinutes: 60,
    },
    activeJob,
    now,
  });
  assert.equal(feasible.feasible, true);
});

test("scheduled eligibility rejects a technician with no travel origin", async () => {
  const technician = makeTechnician({ serviceBaseLocation: null, location: null });
  const booking = makeScheduledBooking();
  const result = await evaluateTechnicianEligibility({
    technician,
    booking,
    mode: "BROADCAST",
    context: eligibilityContext,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("MISSING_LOCATION"));
});

test("scheduled eligibility uses the service base location and permits offline broadcast", async () => {
  const technician = makeTechnician();
  const booking = makeScheduledBooking();
  const broadcast = await evaluateTechnicianEligibility({
    technician,
    booking,
    mode: "BROADCAST",
    context: eligibilityContext,
  });
  assert.equal(broadcast.eligible, true, broadcast.reasons.join(","));
  assert.equal(broadcast.details.originSource, "service_base");

  const accept = await evaluateTechnicianEligibility({
    technician,
    booking,
    mode: "ACCEPT",
    context: eligibilityContext,
  });
  assert.equal(accept.eligible, false);
  assert.ok(accept.reasons.includes("TECHNICIAN_OFFLINE"));
});

test("instant eligibility still requires an online technician", async () => {
  const technician = makeTechnician();
  const booking = makeScheduledBooking({ bookingType: "instant", scheduledAt: null });
  const result = await evaluateTechnicianEligibility({
    technician,
    booking,
    mode: "BROADCAST",
    context: eligibilityContext,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("TECHNICIAN_OFFLINE"));
});

test("service base location falls back to last-known live GPS", () => {
  const technician = makeTechnician({ serviceBaseLocation: null });
  const origin = getTechnicianOrigin(technician, "schedule");
  assert.equal(origin.source, "last_known");
  assert.deepEqual(origin.location.coordinates, [77.0, 11.0]);
});

test("late-completion risk compares against the next slot, not the current slot", async () => {
  const { isLateCompletionAtRisk } = await import("../Services/lateCompletionService.js");
  const now = new Date("2026-11-12T04:00:00.000Z");
  const base = {
    slotStartAt: new Date("2026-11-12T03:30:00.000Z"),
    slotEndAt: new Date("2026-11-12T06:30:00.000Z"),
    inProgressAt: new Date("2026-11-12T03:30:00.000Z"),
    estimatedDurationMinutes: 60,
  };
  const nextSlotStartAt = new Date("2026-11-12T06:30:00.000Z");

  assert.equal(isLateCompletionAtRisk(base, now, nextSlotStartAt), false);
  assert.equal(
    isLateCompletionAtRisk({ ...base, estimatedDurationMinutes: 120 }, now, nextSlotStartAt),
    true
  );
  assert.equal(isLateCompletionAtRisk(base, now, null), false);
});
