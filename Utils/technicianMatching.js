import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import { normalizeBookingStatus } from "./bookingStatus.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import TechnicianBookingOffer from "../Schemas/TechnicianBookingOffer.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import Service from "../Schemas/Service.js";
import { findNearbyTechnicians } from "./findNearbyTechnicians.js";
import { emitJobsChanged } from "./sendNotification.js";
import { canArriveBy, computeLatestArrival, haversineMeters } from "./feasibility.js";
import { geoSearch } from "./technicianGeo.js";
import { enqueueJobNewNotifications } from "./dispatchQueue.js";
import { resolveServiceAvailability } from "../Services/serviceAvailabilityService.js";
import { checkTechnicianEligibility } from "../Services/technicianEligibilityService.js";

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

/**
 * 🏙 RESOLVE OPERATIONAL CITY (DISTRICT) FROM COORDINATES
 * Given a lat/lng point, finds the OperationalCity whose GeoJSON polygon contains it.
 */
export const resolveOperationalCityFromCoordinates = async (latitude, longitude) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const city = await OperationalCity.findOne({
    active: true,
    polygon: {
      $geoIntersects: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
      },
    },
  })
    .select("_id name cityId")
    .lean();

  return city;
};

/**
 * 🏙 GET ALL ALLOWED OPERATIONAL CITY (DISTRICT) IDS FOR A TECHNICIAN
 * Returns array of string ObjectIds: [primaryCityId, ...allowedCityIds]
 * Auto-heals legacy profiles without primaryCityId set.
 */
export const getAllowedDistrictIdsForTechnician = async (techProfile) => {
  if (!techProfile) return [];

  let primaryId = techProfile.primaryDistrictId || techProfile.primaryCityId;
  const allowedProfile = [
    ...(techProfile.enabledDistrictIds || []),
    ...(techProfile.allowedCityIds || []),
  ].map((d) => String(d._id || d));

  // Auto-heal legacy profiles if primaryCityId is not set
  if (!primaryId) {
    if (techProfile.cityZoneId) {
      const zone = await CityZone.findById(techProfile.cityZoneId).select("operationalCityId").lean();
      if (zone?.operationalCityId) {
        primaryId = zone.operationalCityId;
        await TechnicianProfile.updateOne({ _id: techProfile._id }, { $set: { primaryDistrictId: primaryId, primaryCityId: primaryId } }).catch(() => {});
      }
    } else if (techProfile.city) {
      const matchedCity = await OperationalCity.findOne({
        name: new RegExp(`^${escapeRegExp(String(techProfile.city).trim())}$`, "i"),
        active: true,
      })
        .select("_id")
        .lean();
      if (matchedCity?._id) {
        primaryId = matchedCity._id;
        await TechnicianProfile.updateOne({ _id: techProfile._id }, { $set: { primaryDistrictId: primaryId, primaryCityId: primaryId } }).catch(() => {});
      }
    }
  }

  const allIds = [primaryId, ...allowedProfile].filter(Boolean).map((id) => String(id._id || id));
  return Array.from(new Set(allIds));
};

/**
 * 1. District Permission Check
 */
export const hasDistrictAccess = (technician, districtId) => {
  if (!districtId) return true;
  if (!technician) return false;

  const targetDistStr = String(districtId._id || districtId);
  const primaryDistStr = technician.primaryDistrictId
    ? String(technician.primaryDistrictId._id || technician.primaryDistrictId)
    : technician.primaryCityId
    ? String(technician.primaryCityId._id || technician.primaryCityId)
    : null;

  if (primaryDistStr && primaryDistStr === targetDistStr) {
    return true;
  }

  const enabledDistricts = [
    ...(technician.enabledDistrictIds || []),
    ...(technician.allowedCityIds || []),
  ].map((d) => String(d._id || d));

  return enabledDistricts.includes(targetDistStr);
};

/**
 * 3. City Zone Permission Check
 */
export const hasCityZoneAccess = (technician, cityZoneId) => {
  if (!cityZoneId) return true;
  if (!technician) return false;

  const targetZoneStr = String(cityZoneId._id || cityZoneId);
  const enabledZoneIds = (technician.enabledCityZoneIds || []).map((z) => String(z._id || z));

  if (enabledZoneIds.length > 0) {
    return enabledZoneIds.includes(targetZoneStr);
  }

  if (technician.cityZoneId) {
    return String(technician.cityZoneId._id || technician.cityZoneId) === targetZoneStr;
  }

  return true;
};

/**
 * 8. Final Matching & Job Eligibility Engine
 * Checks District Permission -> Current District -> City Zone Permission -> Current City Zone
 */
export const isTechnicianEligible = (technician, booking) => {
  if (!technician || !booking) return false;

  // 1. District permission
  if (!hasDistrictAccess(technician, booking.districtId)) {
    return false;
  }

  // 2. Physical current district
  if (
    technician.currentDistrictId &&
    booking.districtId &&
    String(technician.currentDistrictId._id || technician.currentDistrictId) !==
      String(booking.districtId._id || booking.districtId)
  ) {
    return false;
  }

  // 3. City zone permission
  if (!hasCityZoneAccess(technician, booking.cityZoneId)) {
    return false;
  }

  // 4. Physical current city zone
  if (
    technician.currentCityZoneId &&
    booking.cityZoneId &&
    String(technician.currentCityZoneId._id || technician.currentCityZoneId) !==
      String(booking.cityZoneId._id || booking.cityZoneId)
  ) {
    return false;
  }

  return true;
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

export const filterByBookingZone = async (techIds, bookingId) => {
  if (!techIds.length) return techIds;

  const booking = await ServiceBooking.findById(bookingId)
    .select("districtId cityZoneId serviceId")
    .lean();

  if (!booking?.cityZoneId) return techIds;

  const eligibleTechs = await TechnicianProfile.find({
    _id: { $in: techIds },
    $or: [
      { enabledCityZoneIds: booking.cityZoneId },
      { cityZoneId: booking.cityZoneId },
      { enabledCityZoneIds: { $exists: false } },
      { enabledCityZoneIds: { $size: 0 } },
    ],
  })
    .select("_id primaryDistrictId primaryCityId enabledDistrictIds allowedCityIds enabledCityZoneIds currentDistrictId currentCityZoneId")
    .lean();

  const finalTechIds = [];
  for (const tech of eligibleTechs) {
    if (isTechnicianEligible(tech, booking)) {
      finalTechIds.push(tech._id);
    }
  }

  return finalTechIds;
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

    // 🏙 DISTRICT-BASED RESTRICTION (CORE RULE: District Permission -> Nearby/Radius Check -> Job Assignment)
    // 1. Get technician's allowed working districts (primary + admin-enabled)
    const allowedDistrictIds = await getAllowedDistrictIdsForTechnician(tech);
    if (allowedDistrictIds.length === 0) {
      console.log(`⚠️ broadcastPendingJobsToTechnician: Tech ${technicianProfileId} has no assigned/enabled district`);
      return { success: false, message: "Technician has no assigned/enabled working district" };
    }

    // 2. Physical GPS Location Check (Requirements 3 & 5):
    // If technician is physically located in a district that is NOT enabled for them,
    // they MUST NOT receive jobs from that district!
    const [lng, lat] = tech.location.coordinates;
    const currentGpsDistrict = await resolveOperationalCityFromCoordinates(lat, lng);
    if (currentGpsDistrict?._id) {
      const currentDistrictIdStr = String(currentGpsDistrict._id);
      if (!allowedDistrictIds.includes(currentDistrictIdStr)) {
        console.log(`⚠️ broadcastPendingJobsToTechnician: Tech ${technicianProfileId} is in district "${currentGpsDistrict.name}" (${currentDistrictIdStr}), which is NOT enabled for them. Allowed: [${allowedDistrictIds.join(", ")}]`);
        return { success: true, count: 0, message: "Technician is physically located in an un-enabled district" };
      }
    }

    // Support both unpopulated (ID) and populated (Object) skills
    const technicianServiceIds = tech.skills
      .map(s => (s.serviceId?._id ? s.serviceId._id : s.serviceId))
      .filter(Boolean);

    if (technicianServiceIds.length === 0) {
      console.log(`⚠️ broadcastPendingJobsToTechnician: Tech ${technicianProfileId} has no valid skills`);
      return { success: false, message: "Technician has no valid skills linked to services" };
    }

    // 3. Filter pending bookings to only include jobs in technician's allowed districts
    const allowedCityObjectIds = allowedDistrictIds.map((id) => new mongoose.Types.ObjectId(id));
    const allowedZones = await CityZone.find({
      operationalCityId: { $in: allowedCityObjectIds },
      active: true,
    })
      .select("_id")
      .lean();
    const allowedZoneIds = allowedZones.map((z) => z._id);

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

    if (allowedZoneIds.length > 0) {
      bookingQuery.cityZoneId = { $in: allowedZoneIds };
    }

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

        if (!isTechnicianEligible(tech, booking)) {
          console.log(`🚫 Skipped job ${booking._id} for tech ${tech._id} — failed district/city zone permission or physical location check`);
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
      }
    }

    console.log(`✅ broadcastPendingJobsToTechnician: Notified tech ${tech._id} of ${newlyBroadcastedCount} new jobs`);

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

    if (newlyBroadcastedCount > 0) {
      await TechnicianProfile.updateOne(
        { _id: tech._id },
        { $set: { lastJobsChangeAt: new Date() } }
      );
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
 * Enforces District Permission FIRST, then Nearby Radius / Geo / Feasibility filters.
 */
export const findEligibleTechniciansForService = async ({
  serviceId,
  address,
  radiusMeters = 10000,
  enableGeo = true,
  limit = 50,
  session,
} = {}) => {
  const serviceObjectId = new mongoose.Types.ObjectId(serviceId);
  const serviceIdString = String(serviceId);

  let approvedKycQuery = TechnicianKyc.find({
    verificationStatus: "approved",
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

  // 🏙 DISTRICT-BASED RESTRICTION (CORE RULE: District Permission -> Nearby/Radius Check -> Job Assignment)
  let jobDistrictId = null;
  if (hasCoords) {
    const jobCity = await resolveOperationalCityFromCoordinates(lat, lng);
    if (jobCity?._id) {
      jobDistrictId = jobCity._id;
    }
  }

  if (!jobDistrictId && address?.cityZoneId) {
    const zone = await CityZone.findById(address.cityZoneId).select("operationalCityId").lean();
    if (zone?.operationalCityId) jobDistrictId = zone.operationalCityId;
  }

  if (jobDistrictId) {
    const jobDistrictObjId = new mongoose.Types.ObjectId(jobDistrictId);
    baseQuery.$and = baseQuery.$and || [];
    baseQuery.$and.push({
      $or: [
        { primaryCityId: jobDistrictObjId },
        { allowedCityIds: jobDistrictObjId },
      ],
    });
  }

  if (enableGeo && hasCoords) {
    const redisNearby = await geoSearch(lng, lat, radiusMeters, limit);
    if (redisNearby?.length) {
      const candidateIds = redisNearby.map((r) => r.technicianId);
      let redisQuery = TechnicianProfile.find({ ...baseQuery, _id: { $in: candidateIds } })
        .select("_id")
        .limit(limit);
      if (session) redisQuery = redisQuery.session(session);
      const redisMatches = await redisQuery;
      if (redisMatches.length > 0) {
        return filterByOperationalPolygon(redisMatches.map((t) => t._id));
      }
    }

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
      return filterByOperationalPolygon(nearby.map((t) => t._id));
    }
  }

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

    // 0. Check Service Availability at Customer Location
    let targetDistrictId = booking.districtId;
    if (!targetDistrictId && Number.isFinite(latitude) && Number.isFinite(longitude)) {
      const city = await resolveOperationalCityFromCoordinates(latitude, longitude);
      if (city?._id) targetDistrictId = city._id;
    }

    if (targetDistrictId) {
      const avail = await resolveServiceAvailability({
        serviceId: booking.serviceId,
        districtId: targetDistrictId,
        cityId: booking.cityZoneId,
      });

      if (!avail.available) {
        console.log(`⚠️ matchAndBroadcastBooking: Service ${booking.serviceId} unavailable at customer location (${avail.reason})`);
        return { success: true, count: 0, message: `Service unavailable at customer location (${avail.reason})` };
      }
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
