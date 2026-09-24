import express from "express";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { Server } from "socket.io";
import { SOCKET_EVENTS, SOCKET_ROOMS } from "./Utils/socketConstants.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

// Load environment variables
dotenv.config();

// 🔴 Redis Socket.IO Adapter (multi-server support)
// Initialized lazily; if Redis unavailable, runs single-node with warning.
let redisPubClient = null;
let redisSubClient = null;
const initRedisAdapter = async (io) => {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  try {
    redisPubClient = createClient({ url: redisUrl });
    redisSubClient = redisPubClient.duplicate();
    await Promise.all([redisPubClient.connect(), redisSubClient.connect()]);
    io.adapter(createAdapter(redisPubClient, redisSubClient));
    console.log("🔴 Redis Socket.IO adapter connected — multi-server pub/sub enabled");
    console.warn("⚠️ Presence/rate-limit maps remain per-process: single-session kick and socket budgets are best-effort across replicas until moved to a shared store.");
  } catch (err) {
    console.warn(`⚠️ Redis adapter unavailable (${err.message}) — running single-node`);
    redisPubClient = null;
    redisSubClient = null;
  }
};

import { socketAuth } from "./Middleware/socketAuth.js";
import { Auth, authorizeRoles } from "./Middleware/Auth.js";
import isTechnician from "./Middleware/isTechnician.js";
import { createHandshakeLimiter } from "./Middleware/socketRateLimiter.js";
import { startSocketMetricsLogger, recordLocationDrop } from "./Utils/socketMetrics.js";
import TechnicianProfile from "./Schemas/TechnicianProfile.js";
import { setIo } from "./Utils/ioAccess.js";

/* ================= ROUTE IMPORTS ================= */
// Admin Route Imports
import adminWalletRoutes from "./Routes/adminWalletRoutes.js";
import adminKycRoutes from "./Routes/adminKycRoutes.js";
import adminPaymentRoutes from "./Routes/adminPaymentRoutes.js";
import operationalCityRoutes from "./Routes/operationalCityRoutes.js";
import adminTechnicianDistrictRoutes from "./Routes/adminTechnicianDistrictRoutes.js";
import adminZoneRoutes from "./Routes/adminZones.js";
import adminPermissionRoutes from "./Routes/adminPermissionRoutes.js";
import adminProductDashboardRoutes from "./Routes/adminProductDashboardRoutes.js";
import adminServiceAvailabilityRoutes from "./Routes/adminServiceAvailabilityRoutes.js";
import adminSkillRequestRoutes from "./Routes/adminSkillRequestRoutes.js";
import adminZoneGeofenceRoutes from "./Routes/adminZoneGeofenceRoutes.js";
import adminRefundsRoutes from "./Routes/adminRefunds.js";
import adminQuotationRoutes from "./Routes/adminQuotationRoutes.js";

// Technician Route Imports
import TechnicianRoutes from "./Routes/technician.js";
import technicianWalletRoutes from "./Routes/technicianWalletRoutes.js";
import technicianRefundsRoutes from "./Routes/technicianRefunds.js";

// Customer / User Route Imports
import UserRoutes from "./Routes/User.js";
import AddressRoutes from "./Routes/address.js";
import customerPaymentsRoutes from "./Routes/customerPayments.js";
import userZoneRoutes from "./Routes/userZones.js";
import userReportsRoutes from "./Routes/userReports.js";
import productQuoteRoutes from "./Routes/productQuoteRoutes.js";

// Shared / System Route Imports
import { adminFinanceRoutes, technicianFinanceRoutes } from "./Routes/financeRoutes.js";
import { makePermissionRouter } from "./Routes/permissionRoutes.js";
import { makeDeviceRouter } from "./Routes/deviceRoutes.js";
import notificationRoutes from "./Routes/notificationRoutes.js";
import razorpayXWebhookRoutes from "./Routes/razorpayXWebhookRoutes.js";
import adminDispatchRoutes from "./Routes/adminDispatchRoutes.js";

// Swagger API Documentation
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./swagger.js";

// 🛡 SINGLE ACTIVE SESSION registry (module scope — Socket Analysis Fix #9)
const activeSocketByUser = new Map(); // userId -> socket.id
// NOTE: single-session + the limiters below are per-process. The Redis adapter
// fans out emits cross-server, but presence/buckets don't — with ≥2 replicas
// the same user can hold one socket per replica and budgets multiply by N.
// Full multi-server presence needs a shared store (Redis); see socketRateLimiter.

// 📍 Tech-location budget shared across reconnects (module scope, NOT per-socket).
// 1 ping / 5s == 12/min. Keyed by techProfileId so connectionStateRecovery or a
// reconnect can't reset the budget. Swept by ONE global timer (not per-socket).
const TECH_LOC_LIMIT = { max: 12, windowMs: 60000 };
const techLocationBuckets = new Map(); // techProfileId -> number[] (timestamps)
setInterval(() => {
  const cutoff = Date.now() - TECH_LOC_LIMIT.windowMs;
  for (const [techId, stamps] of techLocationBuckets) {
    const kept = stamps.filter((t) => t > cutoff);
    if (kept.length) techLocationBuckets.set(techId, kept);
    else techLocationBuckets.delete(techId);
  }
}, 60000).unref?.();

const checkTechLocationBudget = (techProfileId) => {
  const now = Date.now();
  const stamps = (techLocationBuckets.get(techProfileId) || []).filter(
    (t) => now - t < TECH_LOC_LIMIT.windowMs
  );
  if (stamps.length >= TECH_LOC_LIMIT.max) {
    recordLocationDrop();
    return false;
  }
  stamps.push(now);
  techLocationBuckets.set(techProfileId, stamps);
  return true;
};

const App = express();

// Express 5-safe sanitizers (mutate objects in place; do not reassign req.query)
const sanitizeNoSqlPayload = (value) => {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item) => sanitizeNoSqlPayload(item));
    return;
  }

  for (const key of Object.keys(value)) {
    const shouldDropKey = key.startsWith("$") || key.includes(".");
    if (shouldDropKey) {
      delete value[key];
      continue;
    }
    sanitizeNoSqlPayload(value[key]);
  }
};

// 🔒 Input handling policy: we ONLY strip NoSQL-prototype keys ($ / dotted).
// We deliberately do NOT blanket HTML-escape every request string — that silently
// corrupts legitimate data (names, notes, addresses, product descriptions that
// contain "<" or ">") and is not real XSS protection. Output encoding must be
// context-aware and is the responsibility of the rendering/client layer. The
// verify() hook above captures req.rawBody BEFORE any mutation so webhook HMACs
// remain valid.

// Global Middlewares (None - consolidated downstream)

App.use(cors({
  exposedHeaders: ["x-new-token", "x-rtb-fingerprint-id", "request-id", "x-request-id"]
}));
App.use(helmet({
  contentSecurityPolicy: false,
}));

// 🔒 Security Hardening - Apply globally

App.use((req, res, next) => {
  // NOTE: req.body is NOT parsed yet at this point (express.json runs later).
  // Params and query are already populated, so they are sanitized here;
  // body sanitization is re-applied AFTER the JSON parser below.
  sanitizeNoSqlPayload(req.params);
  sanitizeNoSqlPayload(req.query);

  next();
});

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: "Too many requests from this IP",
  validate: { trustProxy: false },
});
App.use("/api", limiter);

// MongoDB Connection (Moved downstream)

// Socket.IO Setup with HTTP Server
const httpServer = createServer(App);
// Ensure req.ip works behind proxies (Render/Nginx/etc.)
// Set TRUST_PROXY=true/1 in production if you're behind a reverse proxy.
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxy =
  typeof trustProxyEnv === "string"
    ? trustProxyEnv === "true" || trustProxyEnv === "1"
    : (process.env.NODE_ENV === "production" ? 1 : false);
App.set("trust proxy", trustProxy);

// 🔌 Initialize Socket.IO
// Socket Analysis Fix #2/B1.4: restrict browser-origin handshakes via env.
// Fix #6/B2.2-B4.6: connection-state recovery for short disconnects +
// a tight 500KB payload cap (DTOs are small; the 1MB default kills slow 2G
// clients on large payloads).
const allowedOrigins = () => {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw || !raw.trim()) return true; // native mobile clients have no Origin; keep open unless configured
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
};

const io = new Server(httpServer, {
  cors: { origin: allowedOrigins(), credentials: true },
  connectionStateRecovery: {
    // Replays missed events for short disconnects (tunnel/elevator/app-switch)
    maxDisconnectionDuration: 2 * 60 * 1000,
    // keep middlewares running on recovery so socket.user is re-attached
    skipMiddlewares: false,
  },
  maxHttpBufferSize: 5e5, // 500 KB
});

// 🔌 Hand the io instance to background workers (crons, auto-payout) —
// consumed lazily via getIo() to avoid circular imports.
setIo(io);

// 🛡 Handshake rate limiter MUST run before auth: a flood of junk tokens
// never reaches jwt.verify (Socket Analysis B1.3).
io.use(createHandshakeLimiter({ max: 20, windowMs: 60000 }));

// Socket.IO Middleware & Connection Handler
io.use(socketAuth);

io.on(SOCKET_EVENTS.CONNECTION, (socket) => {
  const userId = socket.user?.userId;
  const role = socket.user?.role;
  const techProfileId = socket.user?.technicianProfileId;

  console.log(`🔌 [SOCKET CONNECTED] SocketID: ${socket.id} (User: ${userId}, Role: ${role}, TechProfile: ${techProfileId})`);

  // 🏠 Standardized User & Role Rooms — ALWAYS use userId
  if (userId) {
    socket.join(SOCKET_ROOMS.USER(userId));
    if (role) {
      socket.join(SOCKET_ROOMS.ROLE(role));
    }
    // Backward compatibility: customer_{userId}
    socket.join(SOCKET_ROOMS.CUSTOMER(userId));
    console.log(`🏠 [USER ROOMS] Joined: user:${userId}, role:${role?.toLowerCase()}`);
  }

  if (role === "Technician" && techProfileId) {
    // Technician operational room — uses techProfileId
    socket.join(SOCKET_ROOMS.TECHNICIAN(techProfileId));
    // DO NOT join user_{techProfileId} — causes ID confusion
    console.log(`🏠 [TECH ROOM] Joined: technician_${techProfileId}`);
  }

  // Admin/Owner dashboard feed (replaces the old global new_booking io.emit —
  // Socket Analysis Fix #1). Only Admin/Owner roles ever see it.
  if (role === "Admin" || role === "Owner") {
    socket.join(SOCKET_ROOMS.ADMIN_DASHBOARD);
    socket.join(SOCKET_ROOMS.ADMIN_ROOM);
    socket.join(SOCKET_ROOMS.ADMIN);
  }

  // 🔍 DIAGNOSTIC: Verify room membership
  setImmediate(() => {
    const rooms = Array.from(socket.rooms);
    console.log(`🔍 [SOCKET ROOMS] ${socket.id} (User: ${userId}, TechProfile: ${techProfileId}) joined:`, rooms);
    
    if (role === "Technician" && techProfileId) {
      const inTechRoom = rooms.includes(`technician_${techProfileId}`);
      const inUserRoom = rooms.includes(`user:${userId}`);
      const inWrongUserRoom = rooms.includes(`user:${techProfileId}`);
      
      if (!inTechRoom) console.error(`❌ [ROOM VERIFY] Missing technician_${techProfileId}`);
      if (!inUserRoom) console.error(`❌ [ROOM VERIFY] Missing user:${userId}`);
      if (inWrongUserRoom) console.warn(`⚠️ [ROOM VERIFY] Incorrectly in user:${techProfileId}`);
    }
  });

  // 🛡 SINGLE ACTIVE SESSION (Socket Analysis Fix #9 / B3.4):
  // one user = one live socket. A new device silently kicks the older one so
  // job alerts / job_taken are never delivered twice.
  // NOTE: reconnection recovery resumes the SAME socket.id, so this only
  // fires on genuine multi-device connections.
  if (userId) {
    const previousSocketId = activeSocketByUser.get(userId);
    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      previousSocket?.emit(SOCKET_EVENTS.SESSION_REPLACED, {
        message: "You have connected from another device.",
      });
      previousSocket?.disconnect(true);
      console.log(`🔁 User ${userId} replaced old socket ${previousSocketId}`);
    }
    activeSocketByUser.set(userId, socket.id);
  }

  // 🛡 RATE LIMITER for Socket Events (simple memory-based)
  const socketRateLimit = new Map();
  const checkRateLimit = (event, limit = 10, windowMs = 1000) => {
    const key = `${socket.id}:${event}`;
    const now = Date.now();
    const timestamps = (socketRateLimit.get(key) || []).filter(t => now - t < windowMs);
    if (timestamps.length >= limit) return false;
    timestamps.push(now);
    socketRateLimit.set(key, timestamps);
    return true;
  };

  // 📍 Location Update Listener (Real-time)
  // Budget is per-tech (module-scope) so reconnects can't reset it, and every
  // drop is acked (the old socket.use() layer dropped silently, hanging
  // client emit(..., ack) until timeout → retry storms).
  socket.on(SOCKET_EVENTS.TECH_LOCATION_UPDATE, async (data, ack) => {
    try {
      if (role !== "Technician" || !techProfileId) return;

      // Rate limit protection - Prevent spamming DB updates (1/5s, 12/min)
      if (!checkTechLocationBudget(techProfileId)) {
        return ack?.({ success: false, throttled: true, retryAfterMs: 5000, message: "Too frequent updates" });
      }

      const { latitude, longitude } = data;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

      const result = await handleLocationUpdate(techProfileId, latitude, longitude, io);

      // ✅ ACK support back to client
      ack?.({ success: true, ...result });
    } catch (err) {
      console.error("Socket Location Update Error:", err.message);
      ack?.({ success: false, message: err.message });
    }
  });

  // 📋 Job Fetch Listener (Real-time) — Socket Analysis Fix #5 (B3.2):
  // rate-limited per socket + cursor-based "unchanged" short-circuit so
  // poll-heavy clients stop paying 3 queries + 3 populates per poll.
  socket.on(SOCKET_EVENTS.TECH_GET_JOBS, async (data, ack) => {
    try {
      if (role !== "Technician" || !techProfileId) {
        return ack?.({ success: false, message: "Unauthorized" });
      }

      // sockets sometimes call emit() with only the ack callback
      if (typeof data === "function") {
        ack = data;
        data = {};
      }
      const payload = data || {};

      if (checkRateLimit(SOCKET_EVENTS.TECH_GET_JOBS, 1, 3000) === false) {
        return ack?.({ success: false, throttled: true, retryAfterMs: 3000 });
      }

      // Cursor short-circuit: if the client's `since` is >= the tech's
      // lastJobsChangeAt, nothing changed — answer without the heavy query.
      let latestVersion = 0;
      try {
        const tech = await TechnicianProfile.findById(techProfileId)
          .select("lastJobsChangeAt")
          .lean();
        latestVersion = tech?.lastJobsChangeAt ? new Date(tech.lastJobsChangeAt).getTime() : 0;
      } catch (err) {
        console.error("Socket Get Jobs cursor read error:", err.message);
      }

      const since = Number(payload?.since) || 0;
      if (since >= latestVersion && latestVersion > 0) {
        // NOTHING CHANGED — no heavy query, no emit. The ack tells the client
        // to back off; clients should prefer the technician:jobs_changed push
        // and call get_jobs only when the push fires (or on connect/foreground).
        return ack?.({ success: true, unchanged: true, count: 0, latestVersion });
      }

      const jobs = await fetchTechnicianJobsInternal(techProfileId);
      // Emit the list ONLY when something actually changed.
      socket.emit(SOCKET_EVENTS.TECH_JOBS_LIST, jobs);

      // ✅ ACK support
      ack?.({ success: true, unchanged: false, count: jobs.length, latestVersion });
    } catch (err) {
      console.error("Socket Get Jobs Error:", err.message);
      ack?.({ success: false, message: err.message });
    }
  });

  socket.on(SOCKET_EVENTS.DISCONNECT, () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    socketRateLimit.clear();

    // release single-active-session slot
    if (userId && activeSocketByUser.get(userId) === socket.id) {
      activeSocketByUser.delete(userId);
    }
  });

  socket.on(SOCKET_EVENTS.ERROR, (err) => {
    console.error(`🚨 Socket error on ${socket.id}:`, err?.message || err);
  });
});

import { handleLocationUpdate } from "./Utils/technicianLocation.js";
import { fetchTechnicianJobsInternal } from "./Utils/technicianJobFetch.js";
import { initBookingCrons } from "./Utils/bookingCron.js";
import { initPaymentCrons } from "./Utils/paymentCrons.js";
import { validateFcmConfig } from "./Utils/firebase.js";
import { startDispatchWorker, stopDispatchWorker } from "./Utils/dispatchQueue.js";
import { startBookingOutboxWorker, stopBookingOutboxWorker } from "./Utils/bookingOutboxWorker.js";
import { startAttemptExpirySweeper, stopAttemptExpirySweeper } from "./Utils/attemptExpirySweeper.js";
import { startPaymentNotificationWorker, stopPaymentNotificationWorker } from "./Utils/paymentNotificationWorker.js";
import { processQuotationDeliveries } from "./Services/quotationDeliveryService.js";
import { expireQuotations } from "./Services/quotationService.js";
import { startNotificationWorker, stopNotificationWorker } from "./Utils/notificationWorker.js";
import {
  refundWorker,
  reconcileRefunds,
  classARefundScanner,
  complaintSlaEscalation,
} from "./Utils/refundEngine.js";
import { releaseExpiredHolds } from "./Utils/complaintFreeze.js";
import { getRefundPolicy } from "./Utils/refundPolicy.js";
import { validateSecrets } from "./Utils/secretValidation.js";

// Middleware to attach io to all requests
App.use((req, res, next) => {
  req.io = io;
  next();
});

// NOTE: Background workers/crons are intentionally NOT started here.
// They must wait for the MongoDB connection to be ready — otherwise
// Mongoose buffers every operation for 10s and floods the log with
// "buffering timed out after 10000ms" errors. See startBackgroundWorkers() below.

// ✅ Single JSON parser with rawBody capture (needed for payment webhooks)

App.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString("utf8");
    },
  })
);

// 🔒 Body sanitization — MUST run after express.json() so req.body exists.
// Only NoSQL-prototype keys are stripped; values are left intact.
App.use((req, res, next) => {
  sanitizeNoSqlPayload(req.body);
  next();
});

// 🔒 General API Rate Limiter (applies to all routes)
const getClientIp = (req) => {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  if (req.ip) return req.ip;
  return req.socket?.remoteAddress || "unknown";
};

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  //sk
  max: 1000, // 1000 requests per window (increased for development)
  message: {
    success: false,
    message: "Too many requests, please try again later",
    result: {},
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Don't crash the process if req.ip is temporarily unavailable (e.g. aborted connections)
  validate: { ip: false, trustProxy: false },
  keyGenerator: (req) => getClientIp(req),
  // Socket.IO uses its own transport endpoints; don't rate-limit those via Express
  skip: (req) => typeof req.path === "string" && req.path.startsWith("/socket.io"),
});

App.use(generalLimiter);

// 🔥 Global Timeout Middleware (Fix Flutter timeout)
App.use((req, res, next) => {
  res.setTimeout(60000, () => {
    console.log("⏳ Request timed out");
    if (!res.headersSent) {
      res.status(408).json({
        success: false,
        message: "Request timeout",
        result: "Request took too long to process",
      });
    }
  });
  next();
});

mongoose.set("strictQuery", false);

// 🔌 Background workers/crons — started ONLY once Mongo is connected, so
// their operations never buffer-timeout. Re-started on every reconnect so a
// dropped connection doesn't leave them dead.
let backgroundStarted = false;
const startBackgroundWorkers = async () => {
  if (backgroundStarted) return;
  backgroundStarted = true;

  // ⏰ Initialize new booking cron jobs (pass io for real-time socket events)
  initBookingCrons(io);

  // 🚚 Dispatch queue worker — async fan-out for broadcast notifications
  startDispatchWorker(io);

  // 📤 Booking outbox worker — broadcast only AFTER booking transaction commit
  startBookingOutboxWorker(io);

  // 💰 Initialize payment reconciliation crons (Phase 1 payments + Phase 3 payouts)
  initPaymentCrons();

  // 💳 Customer payment-management: attempt expiry sweeper + real-time status worker
  startAttemptExpirySweeper();
  startPaymentNotificationWorker();

  // 🧾 Refund / complaint engine crons
  const refundPolicy = await getRefundPolicy();
  setInterval(() => refundWorker(25).catch((e) => console.error("[RefundWorker]", e.message)), 30 * 1000).unref?.();
  setInterval(() => reconcileRefunds().catch((e) => console.error("[RefundReconcile]", e.message)), 5 * 60 * 1000).unref?.();
  setInterval(() => classARefundScanner().catch((e) => console.error("[ClassAScanner]", e.message)), 2 * 60 * 1000).unref?.();
  setInterval(() => complaintSlaEscalation().catch((e) => console.error("[ComplaintSLA]", e.message)), 60 * 60 * 1000).unref?.();
  setInterval(
    () => releaseExpiredHolds(refundPolicy.COMPLAINT_HOLD_MAX_HOURS).catch((e) => console.error("[ReserveFreezeExpiry]", e.message)),
    15 * 60 * 1000
  ).unref?.();

  // 🔔 Central notification system (outbox → socket + FCM push; SMS for OTP)
  startNotificationWorker(5000);

  // 📝 Quotation delivery worker (outbox → in_app + WhatsApp) + expiry sweeper
  setInterval(() => processQuotationDeliveries(25).catch((e) => console.error("[QuotationDelivery]", e.message)), 30 * 1000).unref?.();
  setInterval(() => expireQuotations().catch((e) => console.error("[QuotationExpiry]", e.message)), 60 * 60 * 1000).unref?.();

  console.log("✅ Background workers & crons started after Mongo connection.");
};

// 🩺 Health endpoints — wire into the process supervisor / LB health checks
App.get("/health/live", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

App.get("/health/ready", async (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  if (mongoOk) return res.status(200).json({ status: "ready", mongo: true });
  return res.status(503).json({ status: "not_ready", mongo: mongoOk });
});

App.get("/health/fcm", async (req, res) => {
  const { isFcmEnabled, validateFcmConfig } = await import("./Utils/firebase.js");
  const fcmEnabled = isFcmEnabled();
  const validation = fcmEnabled ? validateFcmConfig() : { valid: false, reason: "not_initialized" };
  const status = fcmEnabled && validation.valid ? 200 : 503;
  res.status(status).json({
    fcmEnabled,
    fcmProjectId: validation.projectId,
    valid: validation.valid,
    reason: validation.reason,
    expectedProjectId: validation.expected,
  });
});

App.get("/health/metrics", async (req, res) => {
  const { notificationMetrics } = await import("./Utils/notificationMetrics.js");
  res.status(200).json(notificationMetrics.getSummary());
});

App.get("/health/socket-rooms/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ success: false, message: "Invalid userId" });
  }

  const techProfile = await TechnicianProfile.findOne({ userId }).select("_id workStatus").lean();
  const techProfileId = techProfile?._id?.toString();

  const expectedRooms = [
    `user:${userId}`,
    `role:technician`,
    `customer_${userId}`,
  ];

  if (techProfileId) {
    expectedRooms.push(`technician_${techProfileId}`);
  }

  // Check actual socket rooms
  const actualRooms = new Set();
  io.sockets.sockets.forEach(socket => {
    if (socket.user?.userId === userId) {
      socket.rooms.forEach(r => actualRooms.add(r));
    }
  });

  const missing = expectedRooms.filter(r => !actualRooms.has(r));
  const unexpected = Array.from(actualRooms).filter(r => 
    !expectedRooms.includes(r) && !r.startsWith("socket:") && r !== socket.id
  );

  res.json({
    success: true,
    userId,
    techProfileId,
    expectedRooms,
    actualRooms: Array.from(actualRooms),
    missingRooms: missing,
    unexpectedRooms: unexpected,
    healthy: missing.length === 0 && unexpected.length === 0
  });
});

/* ==========================================================================
   API ROUTE REGISTRATION (ORGANIZED BY ROLE & DOMAIN)
   ========================================================================== */

/* --------------------------------------------------------------------------
   1. ADMIN & OWNER MANAGEMENT ROUTES (/api/admin)
   -------------------------------------------------------------------------- */
App.use("/api/admin", adminWalletRoutes);
App.use("/api/admin", operationalCityRoutes);
App.use("/api/admin", adminTechnicianDistrictRoutes);
App.use("/api/admin", adminZoneRoutes);
App.use("/api/admin", adminFinanceRoutes);
App.use("/api/admin", adminRefundsRoutes);
App.use("/api/admin", adminQuotationRoutes);
App.use("/api/admin", adminProductDashboardRoutes);
App.use("/api/admin", adminServiceAvailabilityRoutes);
App.use("/api/admin/zone-geofence", adminZoneGeofenceRoutes);
App.use("/api/admin", adminKycRoutes);
App.use("/api/admin", adminSkillRequestRoutes);
App.use("/api/admin/payments", adminPaymentRoutes);
App.use("/api/admin/notifications", Auth, authorizeRoles("Admin", "Owner"), notificationRoutes);
App.use("/api/admin/permissions", adminPermissionRoutes);

/* --------------------------------------------------------------------------
   2. TECHNICIAN ROUTES (/api/technician)
   -------------------------------------------------------------------------- */
App.use("/api/technician", TechnicianRoutes);
App.use("/api/technician", technicianWalletRoutes);
App.use("/api/technician", technicianFinanceRoutes);
App.use("/api/technician", technicianRefundsRoutes);
App.use("/api/technician/notifications", Auth, isTechnician, notificationRoutes);
App.use("/api/technician/permissions", Auth, makePermissionRouter("Technician"));
App.use("/api/technician/device-token", Auth, makeDeviceRouter("Technician"));

/* --------------------------------------------------------------------------
   3. CUSTOMER / USER ROUTES (/api/user)
   -------------------------------------------------------------------------- */
App.use("/api/user", UserRoutes);
App.use("/api/user/payments", customerPaymentsRoutes);
App.use("/api/user/reports", userReportsRoutes);
App.use("/api/user", productQuoteRoutes);
App.use("/api/user/notifications", Auth, notificationRoutes);
App.use("/api/user/permissions", Auth, makePermissionRouter("Customer"));
App.use("/api/user/device-token", Auth, makeDeviceRouter("Customer"));
App.use("/api/addresses", AddressRoutes);
App.use("/api", userZoneRoutes);

/* --------------------------------------------------------------------------
   4. SHARED, SYSTEM & WEBHOOK ROUTES
   -------------------------------------------------------------------------- */
App.use("/api", razorpayXWebhookRoutes);
App.use("/api/admin/dispatch", adminDispatchRoutes);

// 📖 Swagger API Documentation
App.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
App.get("/api-docs.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(swaggerSpec);
});

// ❗ GLOBAL ERROR HANDLER (MUST BE LAST)
App.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);

  // Handle Multer Errors
  if (err instanceof multer.MulterError) {
    let message = err.message;
    if (err.code === "LIMIT_UNEXPECTED_FILE" && err.field) {
      message = `Unexpected field: ${err.field}`;
    } else if (err.code === "LIMIT_FILE_SIZE") {
      message = "File size too large. Max limit is 20MB.";
    }

    return res.status(400).json({
      success: false,
      message: message,
      code: err.code,
    });
  }

  // Handle Body-Parser Errors (JSON Syntax Errors)
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON body",
      result: {},
    });
  }

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.statusCode || err.status || 500;
  return res.status(statusCode).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

// 🚀 UNIFIED SERVER STARTUP SEQUENCE
const startServer = async () => {
  try {
    validateSecrets();
  } catch (err) {
    console.error("❌ Server startup blocked:", err.message);
    process.exit(1);
  }
  try {
    // 1. Connect MongoDB Atlas with optimized connection pooling
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 50,
      minPoolSize: 5,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ Connected to MongoDB Atlas...");

    // 1b. Initialize Redis Socket.IO Adapter for multi-server pub/sub
    await initRedisAdapter(io);

    // 1c. Validate FCM configuration
    const fcmValidation = validateFcmConfig();
    if (!fcmValidation.valid) {
      console.warn(`⚠️ FCM validation: ${fcmValidation.reason}`, fcmValidation);
    } else {
      console.log(`✅ FCM validated for project: ${fcmValidation.projectId}`);
    }

    // 2. Start Background Workers & Crons
    await startBackgroundWorkers();

    // 4. Start HTTP & WebSocket Server
    const port = parseInt(process.env.PORT, 10) || 7372;
    httpServer.listen(port, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${port} (0.0.0.0)`);
      console.log(`🔌 Socket.IO ready for real-time notifications`);
    });

    // 5. Start Socket metrics logger
    startSocketMetricsLogger(io, 60000);
  } catch (err) {
    console.error("❌ Server startup failed:", err);
    process.exit(1);
  }
};

// Mongo connection lifecycle listeners
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB disconnected — workers will pause until reconnect.");
});
mongoose.connection.on("reconnected", () => {
  console.log("✅ MongoDB reconnected — workers resumed.");
});
mongoose.connection.on("error", (err) => {
  console.error("MongoDB connection error:", err.message);
});

startServer();

// 🛑 GRACEFUL SHUTDOWN (Crash & Recovery hardening)
const shutdown = async (signal) => {
  console.log(`🛑 ${signal} received — shutting down gracefully...`);
  try {
    stopDispatchWorker();
    stopBookingOutboxWorker();
    stopAttemptExpirySweeper();
    stopPaymentNotificationWorker();
    stopNotificationWorker();
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await mongoose.connection.close();
    // Close Redis adapter clients
    if (redisPubClient?.isOpen) await redisPubClient.quit();
    if (redisSubClient?.isOpen) await redisSubClient.quit();
  } catch (err) {
    console.error("Shutdown error:", err.message);
  }
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Reloaded district routes mapping
