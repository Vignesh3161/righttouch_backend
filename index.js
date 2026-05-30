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
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { SOCKET_EVENTS, SOCKET_ROOMS } from "./Utils/socketConstants.js";

// Load environment variables
dotenv.config();

import { socketAuth } from "./Middleware/socketAuth.js";
import UserRoutes from "./Routes/User.js";
import TechnicianRoutes from "./Routes/technician.js";
import AddressRoutes from "./Routes/address.js";
import adminWalletRoutes from "./Routes/adminWalletRoutes.js";
import technicianWalletRoutes from "./Routes/technicianWalletRoutes.js";
import DevRoutes from "./Routes/dev.js";

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

const sanitizeStringPayload = (value) => {
  if (typeof value === "string") {
    // Basic escaping for common XSS vectors in user-provided strings.
    return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = sanitizeStringPayload(value[i]);
    }
    return value;
  }

  for (const key of Object.keys(value)) {
    value[key] = sanitizeStringPayload(value[key]);
  }

  return value;
};

// Global Middlewares (None - consolidated downstream)

App.use(cors({
  exposedHeaders: ["x-new-token", "x-rtb-fingerprint-id", "request-id", "x-request-id"]
}));
App.use(helmet());

// 🔒 Security Hardening - Apply globally

App.use((req, res, next) => {
  sanitizeNoSqlPayload(req.body);
  sanitizeNoSqlPayload(req.params);
  sanitizeNoSqlPayload(req.query);

  sanitizeStringPayload(req.body);
  sanitizeStringPayload(req.params);
  sanitizeStringPayload(req.query);

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
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// 🔌 Redis Adapter Setup for Scaling (Required for multi-instance production)
// const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
// const pubClient = createClient({ url: redisUrl });
// const subClient = pubClient.duplicate();

// pubClient.on("error", (err) => console.error("❌ Redis Pub Client Error:", err.message));
// subClient.on("error", (err) => console.error("❌ Redis Sub Client Error:", err.message));

// Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
//   io.adapter(createAdapter(pubClient, subClient));
//   console.log(`✅ Socket.IO Redis Adapter connected scaling active via ${redisUrl}`);
// }).catch(err => {
//   console.error("❌ Redis Adapter Connection Failed:", err.message);
//   console.warn("⚠️ Continuing in single-instance mode...");
// });

// Socket.IO Middleware & Connection Handler
io.use(socketAuth);

io.on(SOCKET_EVENTS.CONNECTION, (socket) => {
  const userId = socket.user?.userId;
  const role = socket.user?.role;
  const techProfileId = socket.user?.technicianProfileId;

  console.log(`🔌 New connection: ${socket.id} (User: ${userId}, Role: ${role})`);

  // 🏠 Room Management - Auto-join based on identity
  if (userId) {
    // Both Customers and Technicians join their private customer room (by userId)
    socket.join(SOCKET_ROOMS.CUSTOMER(userId));
  }

  if (role === "Technician" && techProfileId) {
    socket.join(SOCKET_ROOMS.TECHNICIAN(techProfileId));
    console.log(`🏠 Technician joined room: technician_${techProfileId}`);
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
  socket.on(SOCKET_EVENTS.TECH_LOCATION_UPDATE, async (data, ack) => {
    try {
      if (!role === "Technician" || !techProfileId) return;

      // Rate limit protection - Prevent spamming DB updates
      if (!checkRateLimit(SOCKET_EVENTS.TECH_LOCATION_UPDATE, 1, 5000)) {
        return ack?.({ success: false, message: "Too frequent updates" });
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

  // 📋 Job Fetch Listener (Real-time)
  socket.on(SOCKET_EVENTS.TECH_GET_JOBS, async (ack) => {
    try {
      if (role !== "Technician" || !techProfileId) {
        return ack?.({ success: false, message: "Unauthorized" });
      }

      const jobs = await fetchTechnicianJobsInternal(techProfileId);
      socket.emit(SOCKET_EVENTS.TECH_JOBS_LIST, jobs);

      // ✅ ACK support
      ack?.({ success: true, count: jobs.length });
    } catch (err) {
      console.error("Socket Get Jobs Error:", err.message);
      ack?.({ success: false, message: err.message });
    }
  });

  socket.on(SOCKET_EVENTS.DISCONNECT, () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    socketRateLimit.clear();
  });
});

import { handleLocationUpdate } from "./Utils/technicianLocation.js";
import { fetchTechnicianJobsInternal } from "./Utils/technicianJobFetch.js";
import { initBookingCrons } from "./Utils/bookingCron.js";

// Middleware to attach io to all requests
App.use((req, res, next) => {
  req.io = io;
  next();
});

// ⏰ Initialize new booking cron jobs (pass io for real-time socket events)
initBookingCrons(io);

// ✅ Single JSON parser with rawBody capture (needed for payment webhooks)

App.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString("utf8");
    },
  })
);

// 🔒 Security: Helmet, NoSQL injection prevention, and XSS sanitization
// are now applied globally via middleware above

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

mongoose
  .connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000, // 10 seconds
    socketTimeoutMS: 45000, // 45 seconds
  })
  .then(() => console.log("Connected to MongoDB Atlas..."))
  .catch((err) => console.error("Could not connect to MongoDB...", err));

App.get("/", (req, res) => {
  res.send("welcome");
});

// Routes
App.use("/api/user", UserRoutes);
App.use("/api/technician", TechnicianRoutes);
//sk
App.use("/api/technician", technicianWalletRoutes);
App.use("/api/addresses", AddressRoutes);
App.use("/api/admin", adminWalletRoutes);
App.use("/api/dev", DevRoutes);

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

const port = parseInt(process.env.PORT, 10) || 7372;
httpServer.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🔌 Socket.IO ready for real-time notifications`);
});