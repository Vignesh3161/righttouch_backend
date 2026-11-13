import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import Service from "../Schemas/Service.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import { assertZonePlacement } from "../Services/zoneWriteService.js";
import { resolveServiceZoneFromCoordinates } from "../Utils/resolveZoneFromCoordinates.js";
import { validatePolygonPreview } from "../Controllers/adminZoneGeofenceController.js";

let mongod;

const square = (minX, minY, maxX, maxY) => ({
  type: "Polygon",
  coordinates: [
    [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ],
  ],
});

const districtPolygon = square(77, 11, 77.2, 11.2);

const createDistrict = (overrides = {}) =>
  OperationalCity.create({
    name: "Placement Test District",
    city: "Placement Test City",
    state: "Tamil Nadu",
    polygon: districtPolygon,
    active: true,
    isJobEnabled: true,
    ...overrides,
  });

const createZone = (districtId, name, polygon, overrides = {}) =>
  CityZone.create({
    operationalCityId: districtId,
    name,
    zoneCode: `Z-${new mongoose.Types.ObjectId().toString().slice(-8).toUpperCase()}`,
    polygon,
    active: true,
    ...overrides,
  });

const createService = (name) =>
  Service.create({
    categoryId: new mongoose.Types.ObjectId(),
    serviceName: name,
    description: `${name} description`,
    serviceType: "Repair",
    serviceCost: 100,
    isActive: true,
  });

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    CityZone.deleteMany({}),
    OperationalCity.deleteMany({}),
    Service.deleteMany({}),
    ZoneServiceMapping.deleteMany({}),
    ServiceAvailability.deleteMany({}),
  ]);
});

test("zone fully inside the parent district is accepted", async () => {
  const district = await createDistrict();
  const result = await assertZonePlacement({
    sanitizedPolygon: square(77.02, 11.02, 77.08, 11.08),
    districtId: district._id,
  });

  assert.equal(result.ok, true);
  assert.equal(result.containment.fullyContained, true);
});

test("zone crossing the parent district boundary is rejected", async () => {
  const district = await createDistrict();
  const result = await assertZonePlacement({
    sanitizedPolygon: square(76.99, 11.02, 77.05, 11.08),
    districtId: district._id,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ZONE_OUTSIDE_PARENT_DISTRICT");
  assert.equal(result.containment.fullyContained, false);
});

test("overlapping sibling zones inside the same district are allowed", async () => {
  const district = await createDistrict();
  await createZone(district._id, "Zone A", square(77.02, 11.02, 77.1, 11.1));

  const result = await assertZonePlacement({
    sanitizedPolygon: square(77.05, 11.05, 77.12, 11.12),
    districtId: district._id,
  });

  assert.equal(result.ok, true);
});

test("service-aware resolution picks the overlapping zone mapped to the service", async () => {
  const district = await createDistrict();
  const big = await createZone(
    district._id,
    "Big Zone",
    square(77.02, 11.02, 77.18, 11.18)
  );
  const small = await createZone(
    district._id,
    "Small Zone",
    square(77.05, 11.05, 77.1, 11.1)
  );
  const service = await createService("Split AC Repair");

  await ZoneServiceMapping.create({
    zoneId: small._id,
    serviceId: service._id,
    active: true,
  });

  const result = await resolveServiceZoneFromCoordinates(service._id, 11.06, 77.06);

  assert.equal(result.error, null);
  assert.equal(String(result.zone._id), String(small._id));
  assert.notEqual(String(result.zone._id), String(big._id));
});

test("service-aware resolution prefers the smallest matching overlapping zone", async () => {
  const district = await createDistrict();
  await createZone(district._id, "Big Zone", square(77.02, 11.02, 77.18, 11.18));
  const small = await createZone(
    district._id,
    "Small Zone",
    square(77.05, 11.05, 77.1, 11.1)
  );
  const service = await createService("Split AC Repair");

  const zones = await CityZone.find({ operationalCityId: district._id });
  await ZoneServiceMapping.insertMany(
    zones.map((zone) => ({
      zoneId: zone._id,
      serviceId: service._id,
      active: true,
    }))
  );

  const result = await resolveServiceZoneFromCoordinates(service._id, 11.06, 77.06);

  assert.equal(result.error, null);
  assert.equal(String(result.zone._id), String(small._id));
});

test("service-aware resolution fails when no overlapping zone maps the service", async () => {
  const district = await createDistrict();
  await createZone(district._id, "Big Zone", square(77.02, 11.02, 77.18, 11.18));
  const service = await createService("Split AC Repair");

  const result = await resolveServiceZoneFromCoordinates(service._id, 11.06, 77.06);

  assert.equal(result.error, "SERVICE_NOT_AVAILABLE");
  assert.equal(result.reason, "ZONE_SERVICE_NOT_MAPPED");
});

test("polygon preview accepts an in-district overlap and reports it as allowed", async () => {
  const district = await createDistrict();
  await createZone(district._id, "Existing Zone", square(77.02, 11.02, 77.1, 11.1));

  const res = makeResponse();
  await validatePolygonPreview(
    {
      body: {
        polygon: square(77.05, 11.05, 77.12, 11.12),
        districtId: String(district._id),
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isValid, true);
  assert.equal(res.body.result.containment.isFullyContained, true);
  assert.equal(res.body.result.overlap.allowed, true);
  assert.equal(res.body.result.overlap.hasOverlap, true);
});

test("polygon preview rejects a zone that extends outside the parent district", async () => {
  const district = await createDistrict();

  const res = makeResponse();
  await validatePolygonPreview(
    {
      body: {
        polygon: square(76.99, 11.02, 77.05, 11.08),
        districtId: String(district._id),
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.isValid, false);
  assert.equal(res.body.result.containment.isFullyContained, false);
  assert.match(res.body.result.errors.join(" "), /fully contained/i);
});
