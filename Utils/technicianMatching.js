import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import { normalizeBookingStatus } from "./bookingStatus.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import TechnicianBookingOffer from "../Schemas/TechnicianBookingOffer.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import Service from "../Schemas/Service.js";
import { findNearbyTechnicians } from "./findNearbyTechnicians.js";
import { emitJobsChanged } from "./sendNotification.js";
import { canArriveBy, computeLatestArrival, haversineMeters } from "./feasibility.js";
import { geoSearch } from "./technicianGeo.js";
import { enqueueJobNewNotifications } from "./dispatchQueue.js";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* =====================================================
   DISPATCH FILTERS (staleness / operational polygon)
   — cheap & selective first: geo radius, staleness,
   polygon, availability — feasibility math LAST.
===================================================== */

const STALENESS_SECONDS = (() => {
  const raw = Number(process.env.LOCATION_STALENESS_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
})();

const stalenessCutoff = () => new Date(Date.now() - STALENESS_SECONDS * 1000);

// Active operational polygon — cached in memory (changes rarely), invalidated
// after a TTL so polygon edits propagate without a restart.
let polygonCache = { geometry: null, fetchedAt: 0 };
const POLYGON_CACHE_TTL_MS = 30 * 60 * 1000;

export const getActiveOperationalPolygon = async () => {
  if (
    polygonCache.geometry &&
    Date.now() - polygonCache.fetchedAt < POLYGON_CACHE_TTL_MS
  ) {
    return polygonCache.geometry;
  }
  const city = await OperationalCity.findOne({ active: true })
    .sort({ updatedAt: -1 })
    .select("polygon")
    .lean();
  polygonCache = { geometry: city?.polygon || null, fetchedAt: Date.now() };
  return polygonCache.geometry;
};

/** Invalidate the in-memory polygon cache so edits propagate immediately. */
export const invalidateOperationalPolygonCache = () => {
  polygonCache = { geometry: null, fetchedAt: 0 };
};

/** Drop technicians whose last ping is older than the staleness threshold. */
export const filterStaleTechnicians = (techs) => {
  const cutoff = stalenessCutoff();
  return techs.filter(
    (t) => t.locationUpdatedAt && new Date(t.locationUpdatedAt) >= cutoff
  );
};

/**
 * Intersect a candidate set with the active operational polygon (one indexed
 * $geoIntersects query). No polygon configured → everything passes (backward
 * compatible until polygons are seeded).
 */
export const filterByOperationalPolygon = async (techIds) => {
  if (!techIds.length) return techIds;
  const polygon = await getActiveOperationalPolygon();
  if (!polygon) return techIds;

  const inside = await TechnicianProfile.find({
    _id: { $in: techIds },
    location: { $geoIntersects: { $geometry: polygon } },
  })
    .select("_id")
    .lean();

  return inside.map((t) => t._id);
};

/**
 * 🏘 ZONE FILTER — keep only technicians whose registered cityZoneId matches
 * the booking's cityZoneId, OR whose zone has the service approved.
 * No zone on booking → no filtering (backward compatible).
 * No zone on tech → excluded (tech must register for a zone to receive jobs).
 */
export const filterByBookingZone = async (techIds, bookingId) => {
  if (!techIds.length) return techIds;

  const booking = await ServiceBooking.findById(bookingId)
    .select("cityZoneId serviceId")
    .lean();

  if (!booking?.cityZoneId) return techIds;

  // Technicians registered in the same zone as the booking are eligible
  const sameZoneTechs = await TechnicianProfile.find({
    _id: { $in: techIds },
    cityZoneId: booking.cityZoneId,
  })
    .select("_id")
    .lean();

  return sameZoneTechs.map((t) => t._id);
};

/* =====================================================
   OFFER TRACKING — one row per (booking × technician).
   bulkWrite upsert, ordered:false — $setOnInsert ONLY so
   re-broadcast cycles never reset accepted/superseded rows.
===================================================== */

export const upsertTechnicianOffers = async ({
  bookingId,
  offers,
  channel = "broadcast",
}) => {
  if (!offers?.length) return { count: 0 };
  const bulkOps = offers.map((offer) => ({
    updateOne: {
      filter: { bookingId, technicianId: offer.technicianId },
      update: {
        $setOnInsert: {
          bookingId,
          technicianId: offer.technicianId,
          offeredAt: new Date(),
          channel,
          distanceAtOffer: offer.distanceAtOffer ?? null,
          feasibilitySnapshot: offer.feasibilitySnapshot ?? null,
          decision: "offered",
        },
      },
      upsert: true,
    },
  }));

  const res = await TechnicianBookingOffer.bulkWrite(bulkOps, {
    ordered: false,
  }).catch((e) => {
    console.error("❌ offer upsert failed:", e.message);
    return null;
  });
  return { count: res?.upsertedCount ?? 0 };
};

/**
 * Batch-load every candidate's committed queue (active job + next scheduled
 * bookings) with TWO queries total — never N+1. Returns Map<techId, queue>.
 */
export const loadCommittedQueues = async (techIds) => {
  const map = new Map();
  techIds.forEach((id) =>
    map.set(String(id), { activeJob: null, schedules: [] })
  );
  if (!techIds.length) return map;

  const [activeJobs, schedules] = await Promise.all([
    ServiceBooking.find({
      technicianId: { $in: techIds },
      status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
    })
      .select("technicianId scheduledAt location bookingType")
      .lean(),
    ServiceBooking.find({
      technicianId: { $in: techIds },
      bookingType: "schedule",
      status: { $in: ["accepted"] },
      scheduledAt: { $gt: new Date() },
    })
      .select("technicianId scheduledAt location")
      .sort({ scheduledAt: 1 })
      .lean(),
  ]);

  for (const job of activeJobs) {
    const entry = map.get(String(job.technicianId));
    if (entry) entry.activeJob = job;
  }
  for (const s of schedules) {
    const entry = map.get(String(s.technicianId));
    if (entry) entry.schedules.push(s);
  }
  return map;
};

/** Next (earliest) committed scheduled booking for a queue entry. */
export const nextScheduledFromQueue = (queue) =>
  queue?.schedules?.[0] || null;

/**
 * Feasibility filter for a candidate job against one technician's committed
 * queue. Instant jobs: forward-pass against the next scheduled appointment.
 * Scheduled jobs: no travel math (fixed future slot) — always feasible here;
 * precise overlap conflicts are rejected at accept time.
 *
 * Returns { feasible, reason, projectedArrival, slackMinutes }.
 */
export const evaluateJobFeasibility = ({
  techLocation,
  candidateJob,
  queue,
}) => {
  const nextSched = nextScheduledFromQueue(queue);

  const isScheduled = candidateJob?.bookingType === "schedule";
  if (!isScheduled && !nextSched) {
    return { feasible: true, reason: "no_deadline", projectedArrival: null, slackMinutes: null };
  }
  if (isScheduled) {
    return { feasible: true, reason: "schedule_appointment", projectedArrival: null, slackMinutes: null };
  }

  return canArriveBy({
    technicianLocation: techLocation,
    committedQueue: [nextSched],
    candidateJob,
    targetLocation: nextSched.location,
    requiredArrivalTime: computeLatestArrival(nextSched.scheduledAt),
  });
};

/**
 * Searches for existing unassigned jobs that match a technician's profile
 * and broadcasts them specifically to that technician.
 * Used when a technician goes online or updates their location.
 */
export const broadcastPendingJobsToTechnician = async (technicianProfileId, io, createdAfter = null) => {
  try {
    const tech = await TechnicianProfile.findById(technicianProfileId);
    if (!tech) return { success: false, message: "Technician not found" };

    const activeJob = await ServiceBooking.findOne({
      technicianId: technicianProfileId,
      status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
    }).select("_id status");

    if (activeJob) {
      return { success: false, message: "Technician has an active job" };
    }

    // Guard: Only approved and online technicians receive jobs
    if (tech.workStatus !== "approved" || !tech.availability?.isOnline) {
      console.log(`⚠️ broadcastPendingJobsToTechnician: Tech ${technicianProfileId} not eligible (status: ${tech.workStatus}, online: ${tech.availability?.isOnline})`);
      return { success: false, message: "Technician not eligible or offline" };
    }

    if (!tech.location || !tech.location.coordinates) {
      console.log(`⚠️ broadcastPendingJobsToTechnician: Tech ${technicianProfileId} has no location`);
      return { success: false, message: "Technician has no location" };
    }

    if (
      STALENESS_SECONDS > 0 &&
      (!tech.locationUpdatedAt || new Date(tech.locationUpdatedAt) < stalenessCutoff())
    ) {
      return { success: false, message: "Technician location is stale — pings not received" };
    }

    // 🏙 Operational polygon — tech outside every active city is not dispatchable.
    const inPolygon = await filterByOperationalPolygon([tech._id]);
    if (inPolygon.length === 0) {
      return { success: false, message: "Technician is outside the operational area" };
    }

    // 🏘 Zone check — tech must be registered in a zone to receive jobs.
    if (!tech.cityZoneId) {
      return { success: false, message: "Technician has no registered zone" };
    }

    const [lng, lat] = tech.location.coordinates;

    // Support both unpopulated (ID) and populated (Object) skills
    const technicianServiceIds = tech.skills
      .map(s => (s.serviceId?._id ? s.serviceId._id : s.serviceId))
      .filter(Boolean);

    console.log(`🔍 broadcastPendingJobsToTechnician: Tech ${technicianProfileId} has ${technicianServiceIds.length} skills`);

    if (technicianServiceIds.length === 0) {
      console.log(`⚠️ broadcastPendingJobsToTechnician: Tech ${technicianProfileId} has no valid skills`);
      return { success: false, message: "Technician has no valid skills linked to services" };
    }

    const bookingQuery = {
      serviceId: { $in: technicianServiceIds },
      technicianId: null,
      status: { $in: ["pending", "broadcasted"] },
      location: {
        $nearSphere: {
          $geometry: { type: "Point", coordinates: [lng, lat] },
          $maxDistance: 10000, // 10km limit
        },
      },
    };

    // If returning from a job, we could optionally filter by time, 
    // but showing all nearby available jobs is generally better for UX.
    if (createdAfter) {
      bookingQuery.createdAt = { $gt: createdAfter };
    }

    let eligibleBookings = await ServiceBooking.find(bookingQuery);

    if (eligibleBookings.length === 0) {
      return { success: true, count: 0, message: "No matching jobs nearby" };
    }

    // ⏱ Feasibility — one batched queue load, then pure in-memory math per
    // candidate. Instant jobs that would make the tech late for their next
    // scheduled appointment are dropped from the offer set entirely.
    const queueMap = await loadCommittedQueues([tech._id]);
    const techQueue = queueMap.get(String(tech._id));

    let newlyBroadcastedCount = 0;
    const offerRows = [];

    // 📤 Batch-load service docs once (no N+1 inside the per-booking loop)
    const serviceIds = [...new Set(eligibleBookings.map((b) => String(b.serviceId)).filter(Boolean))];
    const services = serviceIds.length
      ? await Service.find({ _id: { $in: serviceIds } }).select("_id serviceName serviceType description duration").lean()
      : [];
    const serviceById = new Map(services.map((s) => [String(s._id), s]));

    // Create or revive broadcast records for each matched job
    for (const booking of eligibleBookings) {
      try {
        if (booking.technicianId) {
          continue;
        }

        const feasibility = evaluateJobFeasibility({
          techLocation: tech.location,
          candidateJob: booking,
          queue: techQueue,
        });
        if (!feasibility.feasible) {
          console.log(`⏱ Skipped job ${booking._id} for tech ${tech._id} — ${feasibility.reason} (arrives ${feasibility.projectedArrival})`);
          continue;
        }

        const existing = await JobBroadcast.findOne({
          bookingId: booking._id,
          technicianId: tech._id,
        }).select("status");

        if (existing && ["accepted", "rejected"].includes(existing.status)) {
          continue;
        }

        offerRows.push({
          bookingId: booking._id,
          technicianId: tech._id,
          distanceAtOffer: haversineMeters(
            { latitude: lat, longitude: lng },
            {
              latitude: booking.location?.coordinates?.[1],
              longitude: booking.location?.coordinates?.[0],
            }
          ),
          feasibilitySnapshot: feasibility,
        });

        let broadcast = null;
        if (existing) {
          broadcast = await JobBroadcast.findOneAndUpdate(
            { bookingId: booking._id, technicianId: tech._id },
            { status: "sent", expiresAt: new Date(Date.now() + 60 * 60 * 1000), $inc: { version: 1 } },
            { new: true }
          );
        } else {
          broadcast = await JobBroadcast.create({
            bookingId: booking._id,
            technicianId: tech._id,
            status: "sent",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          });
        }

        if (broadcast) {
          newlyBroadcastedCount++;

          // Send Real-time Alert via the dispatch outbox queue — never block
          // the ping handler on push/socket delivery (dedup+version preserved
          // by the same notifyTechnicianOfNewJob the worker calls).
          const service = serviceById.get(String(booking.serviceId));
          const bm = new Map([[String(tech._id), { _id: broadcast._id, version: broadcast.version }]]);
          await enqueueJobNewNotifications({
            bookingId: booking._id,
            technicianIds: [tech._id],
            jobData: {
              bookingId: booking._id,
              serviceId: service?._id,
              serviceName: service?.serviceName || "New Service",
              serviceType: service?.serviceType,
              description: service?.description,
              duration: service?.duration,
              customerName: booking.addressSnapshot?.name || "Customer",
              baseAmount: booking.baseAmount,
              address: booking.address,
              scheduledAt: booking.scheduledAt,
            },
            broadcastMap: bm,
          });
        }
      } catch (err) {
        if (err.code !== 11000) {
          console.error(`❌ Error broadcasting job ${booking._id} to tech ${tech._id}:`, err);
        }
        // Duplicate is fine - means they already got the job
      }
    }

    console.log(`✅ broadcastPendingJobsToTechnician: Notified tech ${tech._id} of ${newlyBroadcastedCount} new jobs`);

    // 🤝 Offer audit rows — single bulkWrite for every offer made this cycle
    if (offerRows.length > 0) {
      const byBooking = new Map();
      for (const row of offerRows) {
        if (!byBooking.has(String(row.bookingId))) byBooking.set(String(row.bookingId), []);
        byBooking.get(String(row.bookingId)).push(row);
      }
      for (const [bookingId, rows] of byBooking) {
        await upsertTechnicianOffers({ bookingId, offers: rows, channel: "broadcast" });
      }
    }

    // 📍 Cursor bump: the technician's job feed changed — the get_jobs
    // cursor (lastJobsChangeAt) must advance so poll clients can cheaply
    // detect "nothing changed" (Socket Analysis Fix #5).
    if (newlyBroadcastedCount > 0) {
      await TechnicianProfile.updateOne(
        { _id: tech._id },
        { $set: { lastJobsChangeAt: new Date() } }
      );
      // 🛰 Push: tell this technician their feed changed (anti-polling fix).
      emitJobsChanged(io, tech._id);
    }

    return { success: true, count: newlyBroadcastedCount };
  } catch (error) {
    console.error("Match Calculation Error:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Find eligible technicians for a given service + customer location.
 * Rules:
 * - Role = Technician
 */
export const findEligibleTechniciansForService = async ({
  serviceId,
  address,
  radiusMeters = 10000,
  enableGeo = true,
  limit = 50,
  session,
} = {}) => {
  // REMOVED ALL VALIDATIONS: KYC, Online Status, Skills, workStatus, etc.
  // Any technician profile in the system is now "eligible".


  const serviceObjectId = new mongoose.Types.ObjectId(serviceId);
  const serviceIdString = String(serviceId);

  let approvedKycQuery = TechnicianKyc.find({
    verificationStatus: "approved",
    bankVerified: true
  }).select("technicianId");
  if (session) approvedKycQuery = approvedKycQuery.session(session);
  const approvedKyc = await approvedKycQuery;

  const approvedTechnicianIds = approvedKyc
    .map((d) => d.technicianId)
    .filter(Boolean);

  if (approvedTechnicianIds.length === 0) {
    return [];
  }

  const activeTechIdsQuery = ServiceBooking.find({
    technicianId: { $in: approvedTechnicianIds },
    status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
  }).distinct("technicianId");

  const activeTechIds = session
    ? await activeTechIdsQuery.session(session)
    : await activeTechIdsQuery;

  const baseQuery = {
    _id: { $in: approvedTechnicianIds, $nin: activeTechIds },
    workStatus: "approved",
    profileComplete: true,
    trainingCompleted: true,
    "availability.isOnline": true,
    $or: [
      { "skills.serviceId": serviceObjectId },
      { "skills.serviceId": serviceIdString },
    ],
  };

  // ⏱ Staleness gate — drop techs whose last ping is older than the threshold
  if (STALENESS_SECONDS > 0) {
    baseQuery.locationUpdatedAt = { $gte: stalenessCutoff() };
  }

  const lat = Number(address?.latitude);
  const lng = Number(address?.longitude);

  const hasCoords =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  // 1) Prefer geo query when possible (requires technicians to have `location`)
  if (enableGeo && hasCoords) {
    // 🗺 Redis GEO hot path — sub-ms radius pre-filter, then ONE indexed
    // _id query for the remaining filters (staleness/skills/online/KYC).
    // If Redis is unavailable or returns nothing, fall through to the
    // Mongo $nearSphere path (identical semantics, just slower).
    const redisNearby = await geoSearch(lng, lat, radiusMeters, limit);
    if (redisNearby?.length) {
      const candidateIds = redisNearby.map((r) => r.technicianId);
      let redisQuery = TechnicianProfile.find({ ...baseQuery, _id: { $in: candidateIds } })
        .select("_id")
        .limit(limit);
      if (session) redisQuery = redisQuery.session(session);
      const redisMatches = await redisQuery;
      if (redisMatches.length > 0) {
        // 🏙 Operational polygon — one indexed $geoIntersects on the candidates
        return filterByOperationalPolygon(redisMatches.map((t) => t._id));
      }
    }

    // Only match technicians who actually have a valid GeoJSON Point.
    // Many profiles may have latitude/longitude strings but no GeoJSON `location`.
    const geoQuery = {
      ...baseQuery,
      $and: [
        { "location.type": "Point" },
        { "location.coordinates.0": { $type: "number" } },
        { "location.coordinates.1": { $type: "number" } },
        {
          location: {
            $nearSphere: {
              $geometry: {
                type: "Point",
                coordinates: [lng, lat],
              },
              $maxDistance: radiusMeters,
            },
          },
        },
      ],
    };

    let nearbyQuery = TechnicianProfile.find(geoQuery).select("_id").limit(limit);
    if (session) nearbyQuery = nearbyQuery.session(session);
    const nearby = await nearbyQuery;

    if (nearby.length > 0) {
      // 🏙 Operational polygon — one indexed $geoIntersects on the candidate ids
      return filterByOperationalPolygon(nearby.map((t) => t._id));
    }
  }

  // 2) Fallback: pincode / city matching (no coordinates available or no geo matches)
  const fallbackQuery = { ...baseQuery };

  if (address?.pincode) {
    fallbackQuery.pincode = String(address.pincode).trim();
  } else if (address?.city) {
    fallbackQuery.city = new RegExp(`^${escapeRegExp(String(address.city).trim())}$`, "i");
  } else if (address?.state) {
    fallbackQuery.state = new RegExp(`^${escapeRegExp(String(address.state).trim())}$`, "i");
  }

  let fallbackFindQuery = TechnicianProfile.find(fallbackQuery)
    .select("_id")
    .limit(limit);
  if (session) fallbackFindQuery = fallbackFindQuery.session(session);
  const fallbackTechs = await fallbackFindQuery;
  return filterByOperationalPolygon(fallbackTechs.map((t) => t._id));
};

/**
 * Unifies the logic for matching and broadcasting a booking to technicians.
 * Used by both Booking Creation (single) and Checkout (cart).
 *
 * @param {string} bookingId - The ID of the booking to process
 * @param {Object} io - Socket.io instance for real-time notifications
 */
export const matchAndBroadcastBooking = async (bookingId, io) => {
  try {
    const booking = await ServiceBooking.findById(bookingId);
    if (!booking) {
      console.error(`❌ matchAndBroadcastBooking: Booking ${bookingId} not found`);
      return { success: false, message: "Booking not found" };
    }

    if (!["pending", "broadcasted"].includes(normalizeBookingStatus(booking.status))) {
      // Already processed or cancelled
      return { success: false, message: `Booking status is ${booking.status}` };
    }

    const service = await Service.findById(booking.serviceId);
    if (!service) {
      console.error(`❌ matchAndBroadcastBooking: Service ${booking.serviceId} not found`);
      return { success: false, message: "Service not found" };
    }

    // Resolve Location for Matching
    // Booking now has 'location' GeoJSON and 'addressSnapshot'
    // We prioritize the GeoJSON coordinates.
    let latitude, longitude;

    if (booking.location && booking.location.coordinates) {
      // GeoJSON is [lng, lat]
      longitude = booking.location.coordinates[0];
      latitude = booking.location.coordinates[1];
    } else if (booking.addressSnapshot) {
      latitude = booking.addressSnapshot.latitude;
      longitude = booking.addressSnapshot.longitude;
    }

    if ((latitude === undefined || latitude === null) || (longitude === undefined || longitude === null)) {
      console.error(`❌ matchAndBroadcastBooking: No coordinates for booking ${bookingId}. Location:`, JSON.stringify(booking.location), "Snapshot:", JSON.stringify(booking.addressSnapshot));
      return { success: false, message: "No coordinates for booking" };
    }

    // 1. Find Technicians
    const eligibleTechnicians = await findEligibleTechniciansForService({
      serviceId: booking.serviceId,
      address: booking.addressSnapshot || {
        latitude: booking.location?.coordinates[1],
        longitude: booking.location?.coordinates[0]
      },
      limit: 100
    });

    let technicianIds = eligibleTechnicians.map(t => t._id.toString());

    if (technicianIds.length === 0) {
      console.log(`⚠️ No technicians found for booking ${bookingId}`);
      return { success: true, count: 0, message: "No technicians found" };
    }

    // 🏘 ZONE FILTER — only technicians in the same zone as the booking
    if (booking.cityZoneId) {
      technicianIds = await filterByBookingZone(technicianIds, bookingId);
      if (technicianIds.length === 0) {
        console.log(`⚠️ No technicians in zone for booking ${bookingId}`);
        return { success: true, count: 0, message: "No technicians in your zone" };
      }
    }

    // ⏱ Feasibility filter — TWO batched queries (locations + committed queues),
    // then pure in-memory math. Techs who'd be late for their next scheduled
    // appointment because of this job are excluded before anything is sent.
    const [techLocations, queueMap] = await Promise.all([
      TechnicianProfile.find({ _id: { $in: technicianIds } })
        .select("_id location")
        .lean(),
      loadCommittedQueues(technicianIds),
    ]);
    const locationById = new Map(
      techLocations.map((t) => [String(t._id), t.location])
    );

    const offerRows = [];
    const feasibleIds = technicianIds.filter((techId) => {
      const feasibility = evaluateJobFeasibility({
        techLocation: locationById.get(techId),
        candidateJob: booking,
        queue: queueMap.get(techId),
      });
      if (!feasibility.feasible) {
        console.log(`⏱ Excluded tech ${techId} from job ${bookingId} — ${feasibility.reason}`);
        return false;
      }
      offerRows.push({
        bookingId: booking._id,
        technicianId: techId,
        distanceAtOffer: haversineMeters(
          locationById.get(techId),
          {
            latitude: booking.location?.coordinates?.[1],
            longitude: booking.location?.coordinates?.[0],
          }
        ),
        feasibilitySnapshot: feasibility,
      });
      return true;
    });

    technicianIds = feasibleIds;

    if (technicianIds.length === 0) {
      console.log(`⏱ No feasible technicians for booking ${bookingId}`);
      return { success: true, count: 0, message: "No feasible technicians" };
    }

    // 🤝 Offer audit rows — one bulkWrite for the whole candidate set
    await upsertTechnicianOffers({
      bookingId: booking._id,
      offers: offerRows,
      channel: "broadcast",
    });

    // 3. Create JobBroadcast Records
    const jobBroadcastDocs = technicianIds.map(technicianId => ({
      bookingId: booking._id,
      technicianId,
      status: "sent",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour expiry to match Cron
    }));

    try {
      // Update existing or create new broadcasts (upsert)
      const bulkOps = technicianIds.map(technicianId => ({
        updateOne: {
          filter: { bookingId: booking._id, technicianId },
          update: { 
            status: "sent", 
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            $inc: { version: 1 }, // version increments on every re-send
          },
          upsert: true
        }
      }));
      await JobBroadcast.bulkWrite(bulkOps);
    } catch (e) {
      console.error(`❌ matchAndBroadcastBooking: Error in bulkWrite for broadcasts:`, e);
    }

    // Build broadcastId/version map for the job:new DTOs (one query, shared by all emits)
    let broadcastMap = new Map();
    try {
      const broadcastRows = await JobBroadcast.find({
        bookingId: booking._id,
        technicianId: { $in: technicianIds },
      }).select("_id version");
      broadcastMap = new Map(
        broadcastRows.map(b => [b.technicianId.toString(), b])
      );
    } catch (e) {
      console.error("❌ matchAndBroadcastBooking: broadcast map query failed:", e.message);
    }

    // 4. Update Booking Status (canonical only; bump broadcast version so
    //    acceptance can verify the exact version it is claiming)
    await ServiceBooking.updateOne(
      { _id: booking._id },
      {
        $set: { status: "broadcasted", broadcastedAt: new Date(), assignmentStatus: "broadcasted" },
        $inc: { activeBroadcastVersion: 1, version: 1 },
      }
    );

    // 5. Send Notifications (Push + Socket) — via the dispatch outbox queue:
    //    the request/cron thread must not block on N push+socket sends.
    //    The worker delivers with bounded concurrency + backoff, calling the
    //    same deduped notifyTechnicianOfNewJob (alreadySent 5-min window).
    await enqueueJobNewNotifications({
      bookingId: booking._id,
      technicianIds,
      jobData: {
        bookingId: booking._id,
        serviceId: service._id,
        serviceName: service.serviceName,
        serviceType: service.serviceType,
        description: service.description,
        duration: service.duration,
        customerName: booking.addressSnapshot?.name || "Customer",
        baseAmount: booking.baseAmount,
        address: booking.address, // legacy string or snapshot line
        scheduledAt: booking.scheduledAt,
      },
      broadcastMap,
    });

    // 📍 Cursor bump for every matched technician (Socket Analysis Fix #5)
    try {
      await TechnicianProfile.updateMany(
        { _id: { $in: technicianIds } },
        { $set: { lastJobsChangeAt: new Date() } }
      );
      // 🛰 Push: every matched tech's feed changed (anti-polling fix).
      technicianIds.forEach((techId) => emitJobsChanged(io, techId));
    } catch (e) {
      console.error("❌ matchAndBroadcastBooking: cursor bump failed:", e.message);
    }

    console.log(`✅ matchAndBroadcastBooking: Broadcasted booking ${bookingId} to ${technicianIds.length} techs`);
    return { success: true, count: technicianIds.length };

  } catch (error) {
    console.error("❌ matchAndBroadcastBooking Error:", error);
    return { success: false, error: error.message };
  }
};

