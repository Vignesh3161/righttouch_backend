import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Server } from "socket.io";

import { hasLiveSocket } from "../Utils/sendNotification.js";

/**
 * Regression tests for the live-job delivery fix:
 *
 * Previously notifyTechnicianOfNewJob emitted `job:new` with
 * `.timeout(10000)` to the technician room unconditionally. An OFFLINE
 * technician (no socket in the room) still went through the ack machinery
 * and logged "Job alert ... timed out (No ACK)" — the live-job timeout error
 * seen in production, plus wasted ack timers under concurrent broadcasts.
 *
 * The fix gates the emit behind hasLiveSocket(): offline techs skip the
 * socket path entirely (push-only, no timer, no timeout warning).
 */

let httpServer;
let io;

const start = () =>
  new Promise((resolve) => {
    httpServer = createServer();
    io = new Server(httpServer);
    httpServer.listen(0, () => resolve());
  });

const stop = () =>
  new Promise((resolve) => {
    io.close(() => httpServer.close(() => resolve()));
  });

test.before(async () => {
  await start();
});

test.after(async () => {
  await stop();
});

const room = "technician_abc";

test("hasLiveSocket: offline technician reports false (no emit, no timer)", () => {
  assert.equal(hasLiveSocket(io, "abc"), false);
});

test("hasLiveSocket: technician with a connected socket in the room reports true", () => {
  const nsp = io.of("/");
  nsp.adapter.addAll("fake-sid-1", new Set([room]));
  assert.equal(hasLiveSocket(io, "abc"), true);
});

test("hasLiveSocket: multiple sockets in the same room still report true", () => {
  const nsp = io.of("/");
  nsp.adapter.addAll("fake-sid-2", new Set([room]));
  assert.equal(hasLiveSocket(io, "abc"), true);
  assert.equal(nsp.adapter.rooms.get(room)?.size, 2);
});

test("hasLiveSocket: after disconnect the technician is reported offline again", () => {
  const nsp = io.of("/");
  nsp.adapter.delAll("fake-sid-1");
  nsp.adapter.delAll("fake-sid-2");
  assert.equal(hasLiveSocket(io, "abc"), false);
});

test("hasLiveSocket: safe with nil / malformed inputs", () => {
  assert.equal(hasLiveSocket(null, "abc"), false);
  assert.equal(hasLiveSocket(io, null), false);
  assert.equal(hasLiveSocket(undefined, undefined), false);
});

test("offline path holds no ack timer (live-job timeout regression)", async () => {
  const countTimeouts = () =>
    process._getActiveHandles().filter((h) => h.constructor.name === "Timeout").length;

  const before = countTimeouts();
  // Offline technician: the emit must be skipped entirely — no `.timeout()`
  // timer is scheduled (the push channel is the durable fallback).
  assert.equal(hasLiveSocket(io, "offline-tech-1"), false);

  // Give any (erroneous) timer a chance to be scheduled.
  await new Promise((r) => setTimeout(r, 50));
  const after = countTimeouts();
  assert.equal(after, before, "offline emit must not schedule an ack timer");
});
