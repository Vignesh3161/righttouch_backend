import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import DispatchOutbox from "../Schemas/DispatchOutbox.js";
import { startDispatchWorker, stopDispatchWorker } from "../Utils/dispatchQueue.js";

const router = express.Router();
const adminOnly = authorizeRoles("Admin", "Owner");

/* ================= DISPATCH QUEUE ADMIN ROUTES ================= */

// GET /api/admin/dispatch/stats — Queue statistics
router.get("/stats", Auth, adminOnly, async (req, res) => {
  try {
    const [
      pending,
      inflight,
      done,
      failed,
      total
    ] = await Promise.all([
      DispatchOutbox.countDocuments({ status: "pending" }),
      DispatchOutbox.countDocuments({ status: "inflight" }),
      DispatchOutbox.countDocuments({ status: "done" }),
      DispatchOutbox.countDocuments({ status: "failed" }),
      DispatchOutbox.countDocuments({}),
    ]);

    // Average processing time for completed
    const completed = await DispatchOutbox.aggregate([
      { $match: { status: "done", completedAt: { $exists: true }, claimedAt: { $exists: true } } },
      { $project: { durationMs: { $subtract: ["$completedAt", "$claimedAt"] } } },
      { $group: { _id: null, avgMs: { $avg: "$durationMs" }, maxMs: { $max: "$durationMs" }, minMs: { $min: "$durationMs" } } },
    ]);

    // Retry distribution
    const retryDist = await DispatchOutbox.aggregate([
      { $match: { status: { $in: ["pending", "inflight", "failed"] } } },
      { $group: { _id: "$attempts", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      result: {
        total,
        pending,
        inflight,
        done,
        failed,
        completed: completed[0] || { avgMs: 0, maxMs: 0, minMs: 0 },
        retryDistribution: retryDist.map(r => ({ attempts: r._id, count: r.count })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/dispatch/failed — List failed dispatch items
router.get("/failed", Auth, adminOnly, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      DispatchOutbox.find({ status: "failed" })
        .populate("bookingId", "status serviceId customerId")
        .sort({ lastError: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      DispatchOutbox.countDocuments({ status: "failed" }),
    ]);

    res.json({
      success: true,
      result: items,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      limit,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/dispatch/pending — List pending/inflight items
router.get("/pending", Auth, adminOnly, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const skip = (page - 1) * limit;

    const status = req.query.status || "pending";
    const query = status === "all" 
      ? { status: { $in: ["pending", "inflight"] } }
      : { status };

    const [items, total] = await Promise.all([
      DispatchOutbox.find(query)
        .populate("bookingId", "status serviceId customerId")
        .sort({ nextAttemptAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      DispatchOutbox.countDocuments(query),
    ]);

    res.json({
      success: true,
      result: items,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      limit,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/dispatch/:id/retry — Manually retry a failed/pending item
router.post("/:id/retry", Auth, adminOnly, async (req, res) => {
  try {
    const item = await DispatchOutbox.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Dispatch item not found" });
    }

    if (!["failed", "pending", "inflight"].includes(item.status)) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot retry item with status: ${item.status}` 
      });
    }

    item.status = "pending";
    item.nextAttemptAt = new Date();
    item.attempts = 0;
    item.lastError = null;
    await item.save();

    // Trigger immediate processing
    const { poll } = await import("../Utils/dispatchQueue.js");
    poll().catch(() => {});

    res.json({ 
      success: true, 
      message: "Dispatch item queued for retry",
      result: { id: item._id, status: "pending" },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/dispatch/retry-failed — Bulk retry all failed items
router.post("/retry-failed", Auth, adminOnly, async (req, res) => {
  try {
    const result = await DispatchOutbox.updateMany(
      { status: "failed" },
      { 
        $set: { 
          status: "pending", 
          nextAttemptAt: new Date(),
          attempts: 0,
          lastError: null,
        } 
      }
    );

    // Trigger immediate processing
    const { poll } = await import("../Utils/dispatchQueue.js");
    poll().catch(() => {});

    res.json({
      success: true,
      message: `${result.modifiedCount} failed items queued for retry`,
      result: { modifiedCount: result.modifiedCount },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/dispatch/worker/restart — Restart dispatch worker
router.post("/worker/restart", Auth, adminOnly, async (req, res) => {
  try {
    const { io } = req.app;
    stopDispatchWorker();
    startDispatchWorker(io);
    res.json({ success: true, message: "Dispatch worker restarted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/dispatch/worker/stop — Stop dispatch worker
router.post("/worker/stop", Auth, adminOnly, async (req, res) => {
  try {
    stopDispatchWorker();
    res.json({ success: true, message: "Dispatch worker stopped" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/dispatch/health — Worker health check
router.get("/health", Auth, adminOnly, async (req, res) => {
  try {
    const { getRedisClient, isRedisAvailable } = await import("../Utils/redisDedupe.js");
    const redisAvailable = isRedisAvailable();
    
    res.json({
      success: true,
      result: {
        redisAvailable,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;