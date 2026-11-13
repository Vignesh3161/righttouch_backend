import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

let replSet;
let TechnicianProfile;
let TechnicianKyc;
let SlotCapacity;
let acquireSlotCapacity;

const point = (longitude, latitude) => ({
  type: "Point",
  coordinates: [longitude, latitude],
});

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { directConnection: true });
  ({ default: TechnicianProfile } = await import("../Schemas/TechnicianProfile.js"));
  ({ default: TechnicianKyc } = await import("../Schemas/TechnicianKYC.js"));
  ({ default: SlotCapacity } = await import("../Schemas/SlotCapacity.js"));
  ({ acquireSlotCapacity } = await import("../Services/slotCapacityService.js"));
});

after(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

test("50 concurrent last-slot acquisitions admit exactly one booking", async () => {
  const serviceId = new mongoose.Types.ObjectId();

  const technician = await TechnicianProfile.create({
    userId: new mongoose.Types.ObjectId(),
    workStatus: "approved",
    profileComplete: true,
    trainingCompleted: true,
    skills: [{ serviceId }],
    serviceBaseLocation: point(77.0, 11.0),
    location: point(77.0, 11.0),
    locationUpdatedAt: new Date(),
    serviceRadiusKm: 100,
    notificationPreferences: { scheduledOffersEnabled: true },
  });
  await TechnicianKyc.create({
    technicianId: technician._id,
    verificationStatus: "approved",
    kycVerified: true,
    bankVerified: true,
    bankVerificationStatus: "approved",
  });

  const slotKey = "2026-11-20|12:00-15:00";
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      acquireSlotCapacity({
        slotKey,
        serviceId,
        latitude: 11.0,
        longitude: 77.0,
      })
    )
  );

  const winners = results.filter((result) => result.ok);
  const busy = results.filter((result) => !result.ok && result.code === "SLOT_BUSY");
  assert.equal(winners.length, 1);
  assert.equal(busy.length, 49);

  const capacityRows = await SlotCapacity.find({ slotKey }).lean();
  assert.equal(capacityRows.length, 2);
  for (const row of capacityRows) {
    assert.equal(row.capacity, 1);
    assert.equal(row.held, 1);
    assert.equal(row.confirmed, 0);
  }
});
