import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import { geoRemove } from "./technicianGeo.js";
import { emitJobsChanged } from "./sendNotification.js";
import { SOCKET_EVENTS, SOCKET_ROOMS } from "./socketConstants.js";
import { STALENESS_SECONDS } from "./locationConfig.js";
import { METRIC_KEYS, recordMetric } from "./broadcastMetrics.js";

const DEFAULT_OFFLINE_AFTER_SECONDS = 300;
const POLL_INTERVAL_MS = 60 * 1000;
const ACTIVE_JOB_STATUSES = ["accepted", "on_the_way", "reached", "in_progress"];

const OFFLINE_AFTER_SECONDS = (() => {
  const raw = Number(process.env.TECH_OFFLINE_AFTER_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_OFFLINE_AFTER_SECONDS;
  return Math.max(Math.floor(raw), STALENESS_SECONDS + 30);
})();

let timer = null;
let ioRef = null;
let running = false;

export const runTechnicianPresenceSweep = async (io = ioRef) => {
  if (running) return { offline: 0, checked: 0, skipped: "running" };
  running = true;
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - OFFLINE_AFTER_SECONDS * 1000);

    const activeTechIds = await ServiceBooking.distinct("technicianId", {
      technicianId: { $ne: null },
      status: { $in: ACTIVE_JOB_STATUSES },
    });

    const staleCondition = {
      $or: [
        { locationUpdatedAt: null },
        { locationUpdatedAt: { $exists: false } },
        { locationUpdatedAt: { $lt: cutoff } },
        { "location.coordinates": { $exists: false } },
        { "location.coordinates": { $size: 0 } },
        { "location.coordinates.0": { $not: { $type: "number" } } },
        { "location.coordinates.1": { $not: { $type: "number" } } },
        {
          $expr: {
            $or: [
              { $lt: [{ $arrayElemAt: ["$location.coordinates", 1] }, -90] },
              { $gt: [{ $arrayElemAt: ["$location.coordinates", 1] }, 90] },
              { $lt: [{ $arrayElemAt: ["$location.coordinates", 0] }, -180] },
              { $gt: [{ $arrayElemAt: ["$location.coordinates", 0] }, 180] },
            ],
          },
        },
      ],
    };
    const filter = {
      "availability.isOnline": true,
      ...staleCondition,
    };
    if (activeTechIds.length > 0) {
      filter._id = { $nin: activeTechIds };
    }

    const staleTechs = await TechnicianProfile.find(filter)
      .select("_id userId")
      .limit(500)
      .lean();

    if (staleTechs.length === 0) {
      return { offline: 0, checked: 0 };
    }

    const ids = staleTechs.map((tech) => tech._id);
    await TechnicianProfile.updateMany(
      { _id: { $in: ids }, "availability.isOnline": true, ...staleCondition },
      {
        $set: {
          "availability.isOnline": false,
          "availability.offlineReason": "gps_stale",
          "availability.offlineAt": now,
        },
      }
    );

    const offlineTechs = await TechnicianProfile.find({
      _id: { $in: ids },
      "availability.isOnline": false,
      "availability.offlineReason": "gps_stale",
      "availability.offlineAt": now,
    })
      .select("_id userId")
      .lean();

    const offlineIds = offlineTechs.map((tech) => tech._id);
    if (offlineIds.length > 0) {
      await JobBroadcast.updateMany(
        { technicianId: { $in: offlineIds }, status: "sent" },
        {
          $set: {
            status: "expired",
            expiredAt: now,
            expiredReason: "gps_stale",
          },
        }
      );
    }

    const payload = {
      code: "GPS_STALE",
      reason: "gps_stale",
      at: now.toISOString(),
    };

    for (const tech of offlineTechs) {
      geoRemove(tech._id).catch(() => {});
      emitJobsChanged(io, tech._id, {
        action: "gps_stale",
        reasons: ["GPS_STALE"],
        userId: tech.userId ? String(tech.userId) : undefined,
      });
      if (!io) continue;
      io.to(SOCKET_ROOMS.TECHNICIAN(tech._id)).emit(SOCKET_EVENTS.TECH_OFFLINE, payload);
      if (tech.userId) {
        io.to(SOCKET_ROOMS.USER(tech.userId)).emit(SOCKET_EVENTS.TECH_OFFLINE, payload);
      }
    }

    const offline = offlineTechs.length;
    recordMetric(METRIC_KEYS.TECHS_AUTO_OFFLINE, offline);
    console.log(`[PresenceSweeper] auto-offline ${offline}/${staleTechs.length} stale technicians`);
    return { offline, checked: staleTechs.length };
  } finally {
    running = false;
  }
};

export const startTechnicianPresenceSweeper = (io) => {
  ioRef = io;
  if (timer) clearInterval(timer);
  runTechnicianPresenceSweep(io).catch((err) =>
    console.error("[PresenceSweeper] initial sweep failed:", err.message)
  );
  timer = setInterval(() => {
    runTechnicianPresenceSweep(io).catch((err) =>
      console.error("[PresenceSweeper] sweep failed:", err.message)
    );
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  console.log(`[PresenceSweeper] started (offlineAfter=${OFFLINE_AFTER_SECONDS}s)`);
};

export const stopTechnicianPresenceSweeper = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
