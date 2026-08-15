import test from "node:test";
import assert from "node:assert/strict";

import {
  toBookingCreatedDTO,
  toBookingCancelledDTO,
  toJobNewDTO,
} from "../Utils/socketDTO.js";

const mockBooking = {
  _id: "64f1a2b3c4d5e6f7a8b9c0d1",
  status: "pending",
  scheduledAt: new Date("2025-01-10T10:00:00Z"),
  baseAmount: 499,
  address: "12, MG Road, Bengaluru",
  addressSnapshot: { name: "Aarav" },
};

const mockBroadcast = { _id: "bcast001", version: 2 };

const jobData = {
  bookingId: mockBooking._id,
  serviceId: "svc001",
  serviceName: "AC Repair",
  serviceType: "repair",
  description: "Split AC not cooling",
  duration: 60,
  customerName: "Aarav",
  baseAmount: 499,
  address: mockBooking.address,
  scheduledAt: mockBooking.scheduledAt,
};

test("booking_created DTO: stable public field set only, no PII", () => {
  const dto = toBookingCreatedDTO(mockBooking);
  assert.deepEqual(
    Object.keys(dto).sort(),
    ["baseAmount", "bookingId", "scheduledAt", "status"].sort()
  );
  assert.equal(dto.address, undefined);           // no raw address
  assert.equal(dto.addressSnapshot, undefined);   // no name snapshot
  assert.equal(dto.coordinates, undefined);       // no geo data
});

test("booking_cancelled DTO: bookingId, status=cancelled, reason only", () => {
  const dto = toBookingCancelledDTO(mockBooking, "no_technician_accept");
  assert.deepEqual(
    Object.keys(dto).sort(),
    ["bookingId", "reason", "status"].sort()
  );
  assert.equal(dto.status, "cancelled");
  assert.equal(dto.reason, "no_technician_accept");
  assert.equal(dto.address, undefined);
});

test("job:new DTO contains the legacy client contract fields", () => {
  const dto = toJobNewDTO(jobData, mockBroadcast);
  for (const field of [
    "bookingId", "serviceId", "serviceName", "description",
    "duration", "customerName", "baseAmount", "address", "scheduledAt",
  ]) {
    assert.ok(field in dto, `missing client field: ${field}`);
  }
  assert.equal(dto.serviceName, "AC Repair");
  assert.equal(dto.customerName, "Aarav");
});

test("job:new DTO adds broadcastId + version and never leaks PII/coordinates", () => {
  const dto = toJobNewDTO(jobData, mockBroadcast);
  assert.equal(dto.broadcastId, "bcast001");
  assert.equal(dto.version, 2);
  assert.equal(dto.version, 2);
  assert.equal(dto.coordinates, undefined);
  assert.equal(dto.mobileNumber, undefined);
  assert.equal(dto.customerId, undefined);
  assert.equal(dto.technicianId, undefined);
});

test("job:new DTO version defaults to 1 for brand-new broadcast", () => {
  const dto = toJobNewDTO(jobData, { _id: "bcast002" }); // no version field
  assert.equal(dto.version, 1);
  assert.equal(dto.broadcastId, "bcast002");
});