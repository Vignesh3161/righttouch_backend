import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import Address from "../Schemas/Address.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";

let mongod;
let customerId;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Address.deleteMany({});
  customerId = new mongoose.Types.ObjectId();
});

const createAddress = (overrides = {}) =>
  Address.create({
    customerId,
    label: "home",
    name: "Test Customer",
    phone: "9000000000",
    addressLine: "1 Test Street",
    latitude: 12.9716,
    longitude: 77.5946,
    ...overrides,
  });

test("resolves a saved address with coordinates", async () => {
  const address = await createAddress();

  const result = await resolveUserLocation({
    locationType: "saved",
    addressId: address._id.toString(),
    userId: customerId,
  });

  assert.equal(result.success, true);
  assert.equal(result.locationType, "saved");
  assert.equal(result.addressId, address._id.toString());
  assert.equal(result.latitude, 12.9716);
  assert.equal(result.longitude, 77.5946);
  assert.equal(result.addressSnapshot.addressLine, "1 Test Street");
});

test("rejects an address owned by another customer", async () => {
  const address = await createAddress({
    customerId: new mongoose.Types.ObjectId(),
  });

  await assert.rejects(
    () =>
      resolveUserLocation({
        locationType: "saved",
        addressId: address._id.toString(),
        userId: customerId,
      }),
    { statusCode: 400, code: "ADDRESS_NOT_FOUND" }
  );
});

test("rejects an invalid addressId", async () => {
  await assert.rejects(
    () =>
      resolveUserLocation({
        locationType: "saved",
        addressId: "not-an-object-id",
        userId: customerId,
      }),
    { statusCode: 400, code: "INVALID_ADDRESS" }
  );
});

test("rejects a saved address without coordinates", async () => {
  const address = await createAddress({
    latitude: undefined,
    longitude: undefined,
  });

  await assert.rejects(
    () =>
      resolveUserLocation({
        locationType: "saved",
        addressId: address._id.toString(),
        userId: customerId,
      }),
    { statusCode: 400, code: "ADDRESS_LOCATION_REQUIRED" }
  );
});

test("rejects saved locationType without an addressId", async () => {
  await assert.rejects(
    () =>
      resolveUserLocation({
        locationType: "saved",
        latitude: 12.9716,
        longitude: 77.5946,
        userId: customerId,
      }),
    { statusCode: 400, code: "ADDRESS_REQUIRED" }
  );
});

test("rejects empty GPS strings instead of treating them as 0,0", async () => {
  await assert.rejects(
    () =>
      resolveUserLocation({
        locationType: "gps",
        latitude: "",
        longitude: "",
        userId: customerId,
      }),
    { statusCode: 400, code: "LOCATION_REQUIRED" }
  );
});

test("rejects partial GPS coordinates", async () => {
  await assert.rejects(
    () =>
      resolveUserLocation({
        locationType: "gps",
        latitude: 12.9716,
        userId: customerId,
      }),
    { statusCode: 400, code: "INVALID_COORDINATES" }
  );
});

test("resolves numeric-string GPS coordinates", async () => {
  const result = await resolveUserLocation({
    locationType: "gps",
    latitude: "12.9716",
    longitude: "77.5946",
    userId: customerId,
  });

  assert.equal(result.success, true);
  assert.equal(result.locationType, "gps");
  assert.equal(result.latitude, 12.9716);
  assert.equal(result.longitude, 77.5946);
  assert.equal(result.addressSnapshot.addressLine, "Pinned Location");
});

test("rejects GPS coordinates outside valid ranges", async () => {
  await assert.rejects(
    () =>
      resolveUserLocation({
        locationType: "gps",
        latitude: 91,
        longitude: 77.5946,
        userId: customerId,
      }),
    { statusCode: 400, code: "INVALID_COORDINATES" }
  );
});
