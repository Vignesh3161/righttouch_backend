import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

let replSet;
let ServiceBooking;
let TechnicianBroadcast;
let TechnicianBookingOffer;
let DispatchOutbox;
let getDispatchRebroadcastMode;
let planRebroadcastCandidates;
let hasLiveBroadcastsForBooking;
let replaceLiveDispatchRows;
let respondToJob;

const makeRes = () => {
  const res = {};
  res.statusCode = null;
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
  ({ default: TechnicianBroadcast } = await import("../Schemas/TechnicianBroadcast.js"));
  ({ default: TechnicianBookingOffer } = await import("../Schemas/TechnicianBookingOffer.js"));
  ({ default: DispatchOutbox } = await import("../Schemas/DispatchOutbox.js"));
  ({
    getDispatchRebroadcastMode,
    planRebroadcastCandidates,
    hasLiveBroadcastsForBooking,
  } = await import("../Utils/technicianMatching.js"));
  ({ replaceLiveDispatchRows } = await import("../Utils/dispatchQueue.js"));
  ({ respondToJob } = await import("../Controllers/technicianBroadcastController.js"));
});

after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  delete process.env.DISPATCH_REBROADCAST_MODE;
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

const makeBooking = async (overrides = {}) =>
  ServiceBooking.create({
    customerId: new mongoose.Types.ObjectId(),
    serviceId: new mongoose.Types.ObjectId(),
    status: "pending",
    technicianId: null,
    bookingType: "instant",
    locationType: "saved",
    address: "1 Test Street",
    baseAmount: 100,
    totalAmount: 100,
    autoCancelAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  });

test("re-broadcast mode defaults to legacy and only enables on notify_new", () => {
  assert.equal(getDispatchRebroadcastMode(), "legacy");
  process.env.DISPATCH_REBROADCAST_MODE = "notify_new";
  assert.equal(getDispatchRebroadcastMode(), "notify_new");
  process.env.DISPATCH_REBROADCAST_MODE = "banana";
  assert.equal(getDispatchRebroadcastMode(), "legacy");
});

test("legacy plan notifies every candidate unchanged", () => {
  const ids = ["a", "b", "c"];
  const plan = planRebroadcastCandidates({
    candidateIds: ids,
    offersByTechId: new Map([
      ["a", { decision: "declined" }],
      ["b", { decision: "offered" }],
    ]),
    broadcastsByTechId: new Map([
      ["a", { status: "rejected", expiresAt: new Date(Date.now() + 60_000) }],
    ]),
    mode: "legacy",
  });

  assert.deepEqual(plan.notifyIds, ids);
  assert.deepEqual(plan.keepLiveIds, []);
  assert.deepEqual(plan.excludedIds, []);
});

test("notify_new excludes terminal offers and keeps only live offers", () => {
  const now = Date.now();
  const future = new Date(now + 60 * 60 * 1000);
  const past = new Date(now - 1000);
  const ids = ["declined", "live", "expired", "accepted", "legacy-rejected", "stale", "missing"];

  const plan = planRebroadcastCandidates({
    candidateIds: ids,
    offersByTechId: new Map([
      ["declined", { decision: "declined" }],
      ["live", { decision: "offered" }],
      ["expired", { decision: "offered" }],
      ["accepted", { decision: "accepted" }],
      ["legacy-rejected", { decision: "rejected" }],
      ["stale", { decision: "offered" }],
    ]),
    broadcastsByTechId: new Map([
      ["declined", { status: "rejected", expiresAt: future }],
      ["live", { status: "sent", expiresAt: future }],
      ["expired", { status: "expired", expiresAt: past }],
      ["accepted", { status: "accepted", expiresAt: future }],
      ["legacy-rejected", { status: "rejected", expiresAt: future }],
      ["stale", { status: "sent", expiresAt: past }],
    ]),
    mode: "notify_new",
    now,
  });

  assert.deepEqual(plan.excludedIds, ["declined", "accepted", "legacy-rejected"]);
  assert.deepEqual(plan.keepLiveIds, ["live"]);
  assert.deepEqual(plan.notifyIds, ["expired", "stale", "missing"]);
});

test("replaceLiveDispatchRows closes stale live rows and inserts the current version", async () => {
  const bookingId = new mongoose.Types.ObjectId();
  const [a, b, c, d] = Array.from(
    { length: 4 },
    () => new mongoose.Types.ObjectId()
  );
  const oldBroadcastId = new mongoose.Types.ObjectId();
  const newBroadcastId = new mongoose.Types.ObjectId();

  await DispatchOutbox.create([
    {
      bookingId,
      technicianId: a,
      kind: "job_new",
      broadcastId: oldBroadcastId,
      version: 1,
      status: "pending",
      payload: { traceId: "old" },
      nextAttemptAt: new Date(),
    },
    {
      bookingId,
      technicianId: b,
      kind: "job_new",
      broadcastId: oldBroadcastId,
      version: 1,
      status: "inflight",
      claimedAt: new Date(),
      payload: { traceId: "old" },
    },
    {
      bookingId,
      technicianId: c,
      kind: "job_new",
      broadcastId: oldBroadcastId,
      version: 1,
      status: "done",
      completedAt: new Date(),
      payload: { traceId: "old" },
    },
    {
      bookingId,
      technicianId: d,
      kind: "job_new",
      broadcastId: oldBroadcastId,
      version: 1,
      status: "failed",
      lastError: "boom",
      payload: { traceId: "old" },
    },
  ]);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await replaceLiveDispatchRows({
        bookingId,
        technicianIds: [a, b],
        rows: [
          {
            technicianId: a,
            broadcastId: newBroadcastId,
            version: 2,
            payload: { traceId: "new" },
          },
        ],
        session,
      });
    });
  } finally {
    await session.endSession();
  }

  const rows = await DispatchOutbox.find({ bookingId }).lean();
  const byTech = new Map(rows.map((row) => [String(row.technicianId), row]));

  assert.equal(byTech.get(String(a)).status, "pending");
  assert.equal(byTech.get(String(a)).version, 2);
  assert.equal(String(byTech.get(String(a)).broadcastId), String(newBroadcastId));
  assert.equal(byTech.get(String(b)).status, "done");
  assert.equal(byTech.get(String(b)).lastError, "superseded_by_rebroadcast");
  assert.equal(byTech.get(String(c)).status, "done");
  assert.equal(byTech.get(String(c)).version, 1);
  assert.equal(byTech.get(String(d)).status, "failed");
  assert.equal(byTech.get(String(d)).lastError, "boom");
});

test("decline persists the declined enum with its reason", async () => {
  const booking = await makeBooking();
  const technicianId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 60 * 60 * 1000);

  await TechnicianBroadcast.create({
    bookingId: booking._id,
    technicianId,
    status: "sent",
    version: 1,
    expiresAt: future,
    purgeAt: future,
  });
  await TechnicianBookingOffer.create({
    bookingId: booking._id,
    technicianId,
    channel: "broadcast",
    decision: "offered",
    offeredAt: new Date(Date.now() - 1000),
  });

  const res = makeRes();
  await respondToJob(
    {
      user: {
        role: "Technician",
        technicianProfileId: technicianId.toString(),
      },
      params: { id: booking._id.toString() },
      body: { action: "decline", reason: "too_far" },
    },
    res
  );

  assert.equal(res.statusCode, 200);

  const broadcast = await TechnicianBroadcast.findOne({
    bookingId: booking._id,
    technicianId,
  }).lean();
  assert.equal(broadcast.status, "rejected");

  const offer = await TechnicianBookingOffer.findOne({
    bookingId: booking._id,
    technicianId,
  }).lean();
  assert.equal(offer.decision, "declined");
  assert.equal(offer.rejectReason, "too_far");
  assert.ok(Number.isFinite(offer.responseLatencyMs));
  assert.ok(offer.responseLatencyMs >= 0);
});

test("hasLiveBroadcastsForBooking ignores expired and closed offers", async () => {
  const booking = await makeBooking();
  const technicianId = new mongoose.Types.ObjectId();

  assert.equal(await hasLiveBroadcastsForBooking(booking._id), false);

  const live = await TechnicianBroadcast.create({
    bookingId: booking._id,
    technicianId,
    status: "sent",
    version: 1,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  assert.equal(await hasLiveBroadcastsForBooking(booking._id), true);

  await TechnicianBroadcast.updateOne(
    { _id: live._id },
    { $set: { expiresAt: new Date(Date.now() - 1000) } }
  );
  assert.equal(await hasLiveBroadcastsForBooking(booking._id), false);
});
