import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import { expireUnassignedBooking } from "../Utils/bookingExpiry.js";
import { evaluateReacceptEligibility } from "../Utils/bookingReaccept.js";
import { bookingDeadlineFilter } from "../Utils/bookingStatus.js";
import {
  isDuplicateKeyError,
  resolveBookingIdempotencyKey,
} from "../Utils/bookingService.js";

let mongod;

const makeBooking = (overrides = {}) =>
  ServiceBooking.create({
    customerId: new mongoose.Types.ObjectId(),
    serviceId: new mongoose.Types.ObjectId(),
    baseAmount: 100,
    locationType: "gps",
    address: "Test address",
    location: { type: "Point", coordinates: [77, 11] },
    bookingType: "instant",
    status: "pending",
    technicianId: null,
    ...overrides,
  });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ServiceBooking.init();
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await ServiceBooking.deleteMany({});
});

test("expiry helper refuses to overwrite a booking accepted after the sweeper read", async () => {
  const booking = await makeBooking({
    autoCancelAt: new Date(Date.now() - 60_000),
    leaseOwner: "expiry-worker-a",
    leaseUntil: new Date(Date.now() + 60_000),
  });

  await ServiceBooking.updateOne(
    { _id: booking._id },
    {
      $set: {
        status: "accepted",
        technicianId: new mongoose.Types.ObjectId(),
        assignmentStatus: "assigned",
      },
    }
  );

  const expired = await expireUnassignedBooking(booking._id, "expiry-worker-a");
  assert.equal(expired, null);
  const after = await ServiceBooking.findById(booking._id).lean();
  assert.equal(after.status, "accepted");
});

test("expiry helper only expires the unassigned booking owned by the caller lease", async () => {
  const booking = await makeBooking({
    autoCancelAt: new Date(Date.now() - 60_000),
    leaseOwner: "expiry-worker-b",
    leaseUntil: new Date(Date.now() + 60_000),
  });

  const wrongOwner = await expireUnassignedBooking(booking._id, "expiry-worker-c");
  assert.equal(wrongOwner, null);

  const expired = await expireUnassignedBooking(booking._id, "expiry-worker-b");
  assert.ok(expired);
  assert.equal(expired.status, "pending");

  const after = await ServiceBooking.findById(booking._id).lean();
  assert.equal(after.status, "expired");
  assert.equal(after.cancelReason, "no_technician_accept");
  assert.equal(after.cancelledBy, "system");
  assert.equal(after.assignmentStatus, "released");
});

test("deadline filter hides pending bookings whose auto-cancel deadline passed", async () => {
  const future = await makeBooking({ autoCancelAt: new Date(Date.now() + 60_000) });
  const past = await makeBooking({ autoCancelAt: new Date(Date.now() - 60_000) });
  const legacy = await makeBooking({ autoCancelAt: null });

  const rows = await ServiceBooking.find({
    technicianId: null,
    status: { $in: ["pending", "broadcasted"] },
    ...bookingDeadlineFilter(),
  })
    .select("_id")
    .lean();

  const ids = new Set(rows.map((row) => String(row._id)));
  assert.equal(ids.has(String(future._id)), true);
  assert.equal(ids.has(String(legacy._id)), true);
  assert.equal(ids.has(String(past._id)), false);
});

test("reaccept policy allows a recent technician-cancelled instant job", () => {
  const result = evaluateReacceptEligibility({
    booking: {
      status: "cancelled",
      cancelledBy: "technician",
      cancellationStatus: "technician_cancelled",
      cancelledAt: new Date(Date.now() - 60_000),
      reacceptEligible: true,
      bookingType: "instant",
    },
  });
  assert.equal(result.eligible, true);
});

test("reaccept policy blocks customer and system cancellations", () => {
  for (const cancelledBy of ["customer", "system"]) {
    const result = evaluateReacceptEligibility({
      booking: {
        status: "cancelled",
        cancelledBy,
        cancellationStatus: `${cancelledBy}_cancelled`,
        cancelledAt: new Date(),
        reacceptEligible: true,
        bookingType: "instant",
      },
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "not_technician_cancelled");
  }
});

test("reaccept policy blocks old cancellations and past scheduled slots", () => {
  const old = evaluateReacceptEligibility({
    booking: {
      status: "cancelled",
      cancelledBy: "technician",
      cancellationStatus: "technician_cancelled",
      cancelledAt: new Date(Date.now() - 60 * 60 * 1000),
      reacceptEligible: true,
      bookingType: "instant",
    },
  });
  assert.equal(old.eligible, false);
  assert.equal(old.reason, "reaccept_window_expired");

  const pastSlot = evaluateReacceptEligibility({
    booking: {
      status: "cancelled",
      cancelledBy: "technician",
      cancellationStatus: "technician_cancelled",
      cancelledAt: new Date(Date.now() - 60_000),
      reacceptEligible: true,
      bookingType: "schedule",
      scheduledAt: new Date(Date.now() - 60_000),
    },
  });
  assert.equal(pastSlot.eligible, false);
  assert.equal(pastSlot.reason, "scheduled_time_passed");
});

test("reaccept policy tolerates legacy technician cancellations without the new flag", () => {
  const result = evaluateReacceptEligibility({
    booking: {
      status: "cancelled",
      cancelledBy: "technician",
      cancellationStatus: "technician_cancelled",
      updatedAt: new Date(Date.now() - 60_000),
      bookingType: "instant",
    },
  });
  assert.equal(result.eligible, true);
});

test("legacy cancelled bookings hydrate without forcing reacceptEligible to false", async () => {
  const booking = await makeBooking({
    status: "cancelled",
    cancelledBy: "technician",
    cancellationStatus: "technician_cancelled",
    cancelledAt: new Date(Date.now() - 60_000),
    technicianId: new mongoose.Types.ObjectId(),
  });
  await ServiceBooking.collection.updateOne(
    { _id: booking._id },
    { $unset: { reacceptEligible: "" } }
  );

  const loaded = await ServiceBooking.findById(booking._id);
  assert.equal(loaded.reacceptEligible, undefined);
  const result = evaluateReacceptEligibility({ booking: loaded });
  assert.equal(result.eligible, true);
});

test("idempotency keys are stable for explicit and short-window fallback requests", () => {
  const req = {
    get: (name) => (name.toLowerCase() === "idempotency-key" ? "client-key-12345" : undefined),
    headers: {},
    body: {},
  };
  const explicit = resolveBookingIdempotencyKey({
    req,
    scope: "booking-schedule",
    customerId: "customer-1",
    fingerprint: { serviceId: "service-1" },
  });
  const explicitAgain = resolveBookingIdempotencyKey({
    req,
    scope: "booking-schedule",
    customerId: "customer-1",
    fingerprint: { serviceId: "service-1" },
  });
  assert.equal(explicit, explicitAgain);

  const autoReq = { get: () => undefined, headers: {}, body: {} };
  const auto = resolveBookingIdempotencyKey({
    req: autoReq,
    scope: "booking-schedule",
    customerId: "customer-1",
    fingerprint: { serviceId: "service-1", scheduledAt: null },
  });
  const autoAgain = resolveBookingIdempotencyKey({
    req: autoReq,
    scope: "booking-schedule",
    customerId: "customer-1",
    fingerprint: { serviceId: "service-1", scheduledAt: null },
  });
  assert.equal(auto, autoAgain);
  assert.match(auto, /^booking-schedule:customer-1:auto:/);
});

test("ServiceBooking rejects a duplicate idempotency key", async () => {
  await makeBooking({ idempotencyKey: "booking-schedule:customer-1:unique-1" });
  await assert.rejects(
    () => makeBooking({ idempotencyKey: "booking-schedule:customer-1:unique-1" }),
    (error) => isDuplicateKeyError(error)
  );
});
