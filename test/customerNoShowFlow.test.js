import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.CUSTOMER_NO_SHOW_COMPENSATION_ENABLED = "true";
process.env.CUSTOMER_NO_SHOW_WAIT_MINUTES = "15";
process.env.CUSTOMER_NO_SHOW_GEOFENCE_METERS = "100";

let replSet;
let ServiceBooking;
let TechnicianProfile;
let CallLog;
let PlatformLedgerEntry;
let serviceBookController;
let adminController;

const point = (longitude, latitude) => ({
  type: "Point",
  coordinates: [longitude, latitude],
});

const makeRes = () => {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { directConnection: true });
  ({ default: ServiceBooking } = await import("../Schemas/ServiceBooking.js"));
  ({ default: TechnicianProfile } = await import("../Schemas/TechnicianProfile.js"));
  ({ default: CallLog } = await import("../Schemas/CallLog.js"));
  ({ default: PlatformLedgerEntry } = await import("../Schemas/PlatformLedgerEntry.js"));
  serviceBookController = await import("../Controllers/serviceBookController.js");
  adminController = await import("../Controllers/customerNoShowAdminController.js");
});

after(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

test("technician no-show claim requires a real call log and admin approval records liability", async () => {
  const technicianId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const bookingId = new mongoose.Types.ObjectId();
  const reachedAt = new Date(Date.now() - 20 * 60 * 1000);

  await TechnicianProfile.create({
    _id: technicianId,
    userId: new mongoose.Types.ObjectId(),
    workStatus: "approved",
    location: point(77.0, 11.0),
  });
  await ServiceBooking.collection.insertOne({
    _id: bookingId,
    bookingType: "schedule",
    status: "reached",
    technicianId,
    customerId,
    reachedAt,
    location: point(77.0, 11.0),
    financialSnapshot: {
      technicianAmountPaise: 100000,
      totalAmountPaise: 200000,
    },
    customerNoShowStatus: "none",
    customerNoShowCompensationPaise: 0,
    customerNoShowCompensationStatus: "none",
  });
  const callLog = await CallLog.create({
    bookingId,
    technicianId,
    customerId,
    provider: "manual",
    status: "completed",
    verified: true,
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: new Date(Date.now() - 4 * 60 * 1000),
    durationSeconds: 60,
  });

  const reportRes = makeRes();
  await serviceBookController.reportCustomerNoShow(
    {
      params: { id: String(bookingId) },
      user: { role: "Technician", technicianProfileId: String(technicianId) },
      body: { callLogId: String(callLog._id) },
    },
    reportRes
  );
  assert.equal(reportRes.statusCode, 200);
  assert.equal(reportRes.body.result.customerNoShowStatus, "awaiting_customer");

  const customerRes = makeRes();
  await serviceBookController.respondToCustomerNoShow(
    {
      params: { id: String(bookingId) },
      user: { role: "Customer", userId: String(customerId) },
      body: { available: false },
    },
    customerRes
  );
  assert.equal(customerRes.statusCode, 200);
  assert.equal(customerRes.body.result.compensationPaise, 50000);
  assert.equal(customerRes.body.result.compensationStatus, "recorded");

  const approveRes = makeRes();
  await adminController.reviewCustomerNoShowCompensation(
    {
      params: { id: String(bookingId) },
      user: { role: "Admin", userId: String(new mongoose.Types.ObjectId()) },
      body: { action: "approve", note: "verified" },
    },
    approveRes
  );
  assert.equal(approveRes.statusCode, 200);
  assert.equal(approveRes.body.result.compensationStatus, "approved");

  const ledger = await PlatformLedgerEntry.findOne({
    idempotencyKey: `customer-no-show-compensation:${bookingId}`,
  }).lean();
  assert.ok(ledger);
  assert.equal(ledger.amountPaise, 50000);
  assert.equal(ledger.status, "pending");
  assert.equal(ledger.direction, "debit");

  const payRes = makeRes();
  await adminController.reviewCustomerNoShowCompensation(
    {
      params: { id: String(bookingId) },
      user: { role: "Admin", userId: String(new mongoose.Types.ObjectId()) },
      body: { action: "mark_paid", providerReference: "manual-bank-1" },
    },
    payRes
  );
  assert.equal(payRes.statusCode, 200);
  assert.equal(payRes.body.result.compensationStatus, "paid");
  const paidLedger = await PlatformLedgerEntry.findOne({
    idempotencyKey: `customer-no-show-compensation:${bookingId}`,
  }).lean();
  assert.equal(paidLedger.status, "posted");
  assert.equal(paidLedger.providerReference, "manual-bank-1");
});

test("no-show claim rejects a fabricated callLogId", async () => {
  const technicianId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const bookingId = new mongoose.Types.ObjectId();

  await TechnicianProfile.create({
    _id: technicianId,
    userId: new mongoose.Types.ObjectId(),
    workStatus: "approved",
    location: point(77.0, 11.0),
  });
  await ServiceBooking.collection.insertOne({
    _id: bookingId,
    bookingType: "schedule",
    status: "reached",
    technicianId,
    customerId,
    reachedAt: new Date(Date.now() - 20 * 60 * 1000),
    location: point(77.0, 11.0),
    financialSnapshot: { technicianAmountPaise: 100000, totalAmountPaise: 200000 },
    customerNoShowStatus: "none",
  });

  const res = makeRes();
  await serviceBookController.reportCustomerNoShow(
    {
      params: { id: String(bookingId) },
      user: { role: "Technician", technicianProfileId: String(technicianId) },
      body: { callLogId: String(new mongoose.Types.ObjectId()) },
    },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "CALL_LOG_INVALID");
});
