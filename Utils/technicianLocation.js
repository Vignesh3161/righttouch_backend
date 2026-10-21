import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianLocationHistory from "../Schemas/TechnicianLocationHistory.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import { broadcastPendingJobsToTechnician } from "./technicianMatching.js";
import { geoAdd } from "./technicianGeo.js";
import { resolveZoneFromCoordinates } from "./resolveZoneFromCoordinates.js";
import { getDistrictFromCoordinates } from "../Services/districtService.js";
import { recordLocationUpdate } from "./socketMetrics.js";
import { evaluateTechnicianEligibility } from "../Services/technicianEligibilityService.js";
import { emitJobExpired, emitJobsChanged } from "./sendNotification.js";
import { STALENESS_SECONDS } from "./locationConfig.js";

/**
 * Common logic to update technician location from HTTP or Socket.
 * Includes rate limiting and distance threshold checks.
 * 
 * @param {String} technicianProfileId 
 * @param {Number} latitude 
 * @param {Number} longitude 
 * @param {Object} io - Socket.io instance
 * @param {String} [via] - "socket" (default) | "http" — for metrics
 * @returns {Object} result
 */
export const handleLocationUpdate = async (technicianProfileId, latitude, longitude, io, via = "socket") => {
    recordLocationUpdate(via);

    if (
        !Number.isFinite(Number(latitude)) ||
        !Number.isFinite(Number(longitude)) ||
        Number(latitude) < -90 ||
        Number(latitude) > 90 ||
        Number(longitude) < -180 ||
        Number(longitude) > 180
    ) {
        throw new Error("Invalid coordinates: latitude must be [-90,90] and longitude [-180,180]");
    }
    latitude = Number(latitude);
    longitude = Number(longitude);

    const profile = await TechnicianProfile.findById(technicianProfileId).select("location lastMatchingAt availability workStatus trainingCompleted");
    if (!profile) throw new Error("Technician profile not found");

    // A location/heartbeat ping updates coordinates and freshness ONLY.
    // Online status is owned exclusively by the explicit availability action
    // (go-online / go-offline); it must never be toggled by a movement ping,
    // otherwise an intentionally-offline technician would flip online simply
    // by moving. We read the CURRENT online state to decide geo-matching
    // membership, but never write `availability.isOnline` here.
    const isOnlineNow = profile.availability?.isOnline === true;

    const [oldLng, oldLat] = profile.location?.coordinates || [0, 0];

    // 1. Distance Gate (Moved > 5 meters)
    const toRad = deg => (deg * Math.PI) / 180;
    const R = 6371000; // meters
    const dLat = toRad(latitude - oldLat);
    const dLng = toRad(longitude - oldLng);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(oldLat)) * Math.cos(toRad(latitude)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const dist = R * c;

    const significantMove = dist > 10; // Increased to 10m for DB efficiency
    const neverUpdated = !profile.location || !profile.location.coordinates;

    if (significantMove || neverUpdated) {
        await TechnicianProfile.updateOne(
            { _id: technicianProfileId },
            {
                location: {
                    type: "Point",
                    coordinates: [longitude, latitude],
                },
                locationUpdatedAt: new Date(),
            }
        );
        console.log(`📍 Tech ${technicianProfileId} moved ${dist.toFixed(1)}m. Location updated (online status unchanged).`);
    } else {
        // No movement — still stamp freshness so the staleness gate
        // (matching excludes pings older than ~90s) keeps working.
        // Single tiny $set, no matching triggered.
        await TechnicianProfile.updateOne(
            { _id: technicianProfileId },
            { locationUpdatedAt: new Date() }
        );
    }

    // 🗺 Redis GEO hot path — upsert position for sub-ms radius pre-filtering
    // during matching. Only online technicians participate in matching; an
    // intentionally-offline technician must stay out of the geo index even
    // though they keep pinging their location. Best-effort: never blocks.
    if (isOnlineNow) {
        geoAdd(technicianProfileId, longitude, latitude).catch(() => {});
    }

    // 🏘 ZONE & DISTRICT RESOLUTION — resolve current physical district and zone from live GPS.
    // B-14: includeInactive so GPS inside a DEACTIVATED zone still records
    // that zone (truthful location state) instead of collapsing to null
    // (which is indistinguishable from outside-coverage). Inactive zones
    // never authorize dispatch — eligibility re-resolves live separately.
    try {
        const { zone: currentZone } = await resolveZoneFromCoordinates(latitude, longitude, { includeInactive: true });
        let resolvedDistrictId = currentZone?.operationalCityId || null;
        let resolvedZoneId = currentZone?._id || null;

        if (!resolvedDistrictId) {
            const gpsDistrict = await getDistrictFromCoordinates(latitude, longitude);
            resolvedDistrictId = gpsDistrict?._id || null;
        }

        await TechnicianProfile.updateOne(
            { _id: technicianProfileId },
            {
                $set: {
                    currentDistrictId: resolvedDistrictId,
                    currentCityZoneId: resolvedZoneId,
                },
            }
        );

        // Asynchronously record location history ping (best-effort, 30-day TTL)
        TechnicianLocationHistory.create({
            technicianId: technicianProfileId,
            location: {
                type: "Point",
                coordinates: [longitude, latitude],
            },
            timestamp: new Date(),
            districtId: resolvedDistrictId || null,
            cityZoneId: resolvedZoneId || null,
            source: via,
        }).catch((histErr) => console.error("Location history record error:", histErr.message));

        const profileWithZone = await TechnicianProfile.findById(technicianProfileId)
            .select("cityZoneId zoneMismatch")
            .lean();

        if (profileWithZone?.cityZoneId) {
            const insideZone = resolvedZoneId && String(resolvedZoneId) === String(profileWithZone.cityZoneId);
            const currentlyMismatched = profileWithZone.zoneMismatch;

            if (!insideZone && !currentlyMismatched) {
                // Drifted outside → flag mismatch
                await TechnicianProfile.updateOne(
                    { _id: technicianProfileId },
                    { $set: { zoneMismatch: true, zoneMismatchSince: new Date() } }
                );
                console.log(`⚠️ Tech ${technicianProfileId} drifted outside zone ${profileWithZone.cityZoneId}`);
            } else if (insideZone && currentlyMismatched) {
                // Back inside → clear mismatch
                await TechnicianProfile.updateOne(
                    { _id: technicianProfileId },
                    { $set: { zoneMismatch: false, zoneMismatchSince: null } }
                );
                console.log(`✅ Tech ${technicianProfileId} returned to zone ${profileWithZone.cityZoneId}`);
            }
        }
    } catch (zoneErr) {
        // Zone check is best-effort — never block location updates
        console.error("Zone/District location resolution error:", zoneErr.message);
    }

    // 🔄 GPS STALENESS CHECK — if GPS is stale, revalidate broadcasts
    if (isOnlineNow && STALENESS_SECONDS > 0 && profile.locationUpdatedAt) {
      const stalenessCutoff = new Date(Date.now() - STALENESS_SECONDS * 1000);
      if (new Date(profile.locationUpdatedAt) < stalenessCutoff) {
        console.log(`⚠️ Tech ${technicianProfileId} GPS is stale, revalidating broadcasts`);
        const techProfile = await TechnicianProfile.findById(technicianProfileId).select("userId").lean();
        const userId = techProfile?.userId?.toString();
        await revalidateActiveBroadcasts(technicianProfileId, latitude, longitude, io, userId);
      }
    }

    // 🔄 REVALIDATE ACTIVE BROADCASTS — if technician moved, check if they're still
    // eligible for previously broadcast jobs. Expire ones they no longer qualify for.
    if (significantMove && isOnlineNow) {
      const techProfile = await TechnicianProfile.findById(technicianProfileId).select("userId").lean();
      const userId = techProfile?.userId?.toString();
      await revalidateActiveBroadcasts(technicianProfileId, latitude, longitude, io, userId);
    }

    // 2. Rate Limit Gate (Job matching once every 30 seconds)
    const lastMatch = profile.lastMatchingAt ? new Date(profile.lastMatchingAt).getTime() : 0;
    const now = Date.now();
    const secondsSinceLastMatch = (now - lastMatch) / 1000;

    if (secondsSinceLastMatch >= 30) {
        console.log(`🔍 Tech ${technicianProfileId}: Triggering job matching (last match ${secondsSinceLastMatch.toFixed(0)}s ago)`);

        // Update lastMatchingAt BEFORE calculation to prevent race conditions
        await TechnicianProfile.updateOne(
            { _id: technicianProfileId },
            { lastMatchingAt: new Date() }
        );

        // Perform calculation
        const matchResult = await broadcastPendingJobsToTechnician(technicianProfileId, io);
        return {
            success: matchResult.success ?? true,
            locationUpdated: significantMove || neverUpdated,
            matchCalculation: true,
            jobsFound: matchResult.count || 0,
            message: matchResult.message || (matchResult.count > 0 ? "Jobs found" : "No matching jobs nearby")
        };
    }

    return {
        success: true,
        locationUpdated: significantMove || neverUpdated,
        matchCalculation: false,
        memo: "Matching rate limited (30s)"
    };
};

/**
 * Revalidate active JobBroadcasts when technician location changes.
 * If technician is no longer eligible for a broadcast job, expire it and notify client.
 * Exported so it can be triggered from other events (service availability, permissions, work status changes).
 */
export async function revalidateActiveBroadcasts(technicianProfileId, latitude, longitude, io, userId = null) {
  const startTime = Date.now();
  console.log("[REVALIDATE_START]", {
    technicianId: technicianProfileId,
    latitude,
    longitude,
    timestamp: new Date().toISOString()
  });

  try {
    // Get active broadcasts for this technician
    const broadcasts = await JobBroadcast.find({
      technicianId: technicianProfileId,
      status: "sent",
      expiresAt: { $gt: new Date() },
    }).select("bookingId version").lean();

    console.log("[REVALIDATE_BROADCASTS_LOADED]", {
      technicianId: technicianProfileId,
      count: broadcasts.length,
      broadcastIds: broadcasts.map(b => String(b.bookingId))
    });

    if (!broadcasts.length) {
      console.log("[REVALIDATE_COMPLETE]", { technicianId: technicianProfileId, action: "NONE", reason: "no_active_broadcasts", durationMs: Date.now() - startTime });
      return;
    }

    // Get technician profile with all fields needed for eligibility check
    const tech = await TechnicianProfile.findById(technicianProfileId).lean();
    if (!tech) {
      console.log("[REVALIDATE_COMPLETE]", { technicianId: technicianProfileId, action: "NONE", reason: "technician_not_found", durationMs: Date.now() - startTime });
      return;
    }

    // Get bookings for these broadcasts
    const bookingIds = broadcasts.map(b => b.bookingId);
    const bookings = await ServiceBooking.find({
      _id: { $in: bookingIds },
      status: { $in: ["pending", "broadcasted"] },
      technicianId: null,
    }).lean();

    console.log("[REVALIDATE_BOOKINGS_LOADED]", {
      technicianId: technicianProfileId,
      bookingCount: bookings.length,
      bookingIds: bookings.map(b => String(b._id))
    });

    if (!bookings.length) {
      console.log("[REVALIDATE_COMPLETE]", { technicianId: technicianProfileId, action: "NONE", reason: "no_valid_bookings", durationMs: Date.now() - startTime });
      return;
    }

    const bookingById = new Map(bookings.map(b => [String(b._id), b]));
    const expiredBroadcasts = [];

    for (const broadcast of broadcasts) {
      const booking = bookingById.get(String(broadcast.bookingId));
      if (!booking) continue;

      // Check eligibility with current location
      const eligibility = await evaluateTechnicianEligibility({
        technician: tech,
        booking,
        mode: "BROADCAST",
      });

      console.log("[ELIGIBILITY_RESULT]", {
        technicianId: technicianProfileId,
        bookingId: String(booking._id),
        broadcastId: String(broadcast._id),
        eligible: eligibility.eligible,
        reasons: eligibility.reasons,
        distanceMeters: eligibility.details?.distanceMeters,
        effectiveRadiusMeters: eligibility.details?.effectiveRadiusMeters,
        gpsFresh: eligibility.details?.gpsFresh,
        online: eligibility.details?.online,
        zonePermission: eligibility.details?.zonePermission,
        districtPermission: eligibility.details?.districtPermission,
        currentDistrictMatch: eligibility.details?.currentDistrictMatch,
        currentZoneMatch: eligibility.details?.currentZoneMatch,
        serviceAvailable: eligibility.details?.serviceAvailable,
        hasSkill: eligibility.details?.hasSkill,
        verified: eligibility.details?.verified
      });

      if (!eligibility.eligible) {
        expiredBroadcasts.push({
          bookingId: broadcast.bookingId,
          broadcastId: broadcast._id,
          reasons: eligibility.reasons
        });
      }
    }

    if (expiredBroadcasts.length > 0) {
      const expiredBookingIds = expiredBroadcasts.map(e => e.bookingId);
      const expiredBroadcastIds = expiredBroadcasts.map(e => e.broadcastId);

      // Expire the broadcasts with atomic condition (status: "sent") to prevent race conditions
      const updateResult = await JobBroadcast.updateMany(
        { 
          _id: { $in: expiredBroadcastIds },
          status: "sent"  // Atomic condition - only expire if still in "sent" state
        },
        { 
          $set: { 
            status: "expired",
            expiredAt: new Date(),
            expiredReason: expiredBroadcasts.map(e => e.reasons.join(", ")).join("; ")
          } 
        }
      );

      console.log("[REVALIDATE_ACTION]", {
        technicianId: technicianProfileId,
        action: "EXPIRE",
        expiredCount: expiredBroadcasts.length,
        matchedCount: updateResult.matchedCount,
        modifiedCount: updateResult.modifiedCount,
        bookingIds: expiredBookingIds.map(String),
        reasons: expiredBroadcasts.flatMap(e => e.reasons)
      });

      // Notify technician via socket that jobs are no longer available
      if (io) {
        for (const expired of expiredBroadcasts) {
          emitJobExpired(io, technicianProfileId, { 
            bookingId: expired.bookingId, 
            broadcastId: expired.broadcastId,
            expiresAt: new Date(), 
            reason: "no_longer_eligible",
            reasons: expired.reasons,
            userId
          });
        }
        // Also emit jobs_changed to trigger feed refresh
        emitJobsChanged(io, technicianProfileId, { userId });
      }
    } else {
      console.log("[REVALIDATE_ACTION]", {
        technicianId: technicianProfileId,
        action: "KEEP",
        checkedCount: broadcasts.length,
        message: "All broadcasts still eligible"
      });
    }

    console.log("[REVALIDATE_COMPLETE]", { 
      technicianId: technicianProfileId, 
      durationMs: Date.now() - startTime,
      expiredCount: expiredBroadcasts.length
    });
  } catch (err) {
    console.error("[REVALIDATE_ERROR]", { 
      technicianId: technicianProfileId, 
      error: err.message,
      stack: err.stack,
      durationMs: Date.now() - startTime
    });
  }
}

/**
 * Revalidate broadcasts affected by a service/availability/district change.
 *
 * B-12/B-18: booking-centric (not per-technician scans). Candidate bookings
 * in scope are loaded once, their sent broadcasts collected, the DISTINCT
 * technicians loaded as COMPLETE documents (projection-only techs caused
 * false ineligibility: missing skills/status/online flags), then each
 * (tech, booking) pair is evaluated with the canonical eligibility fn.
 * Expiry is conditional on status "sent" (atomic); repeated runs are
 * idempotent. serviceId/districtId are nullable for district-wide or
 * global-service sweeps.
 */
export async function revalidateTechniciansForService(serviceId, districtId, cityZoneId, io) {
  const startTime = Date.now();
  console.log("[REVALIDATE_SERVICE_START]", {
    serviceId: serviceId ? String(serviceId) : null,
    districtId: districtId ? String(districtId) : null,
    cityZoneId: cityZoneId ? String(cityZoneId) : null,
    timestamp: new Date().toISOString()
  });

  try {
    const bookingFilter = {
      status: { $in: ["pending", "broadcasted"] },
      technicianId: null,
    };
    if (serviceId) bookingFilter.serviceId = serviceId;
    if (districtId) bookingFilter.districtId = districtId;
    if (cityZoneId && mongoose.Types.ObjectId.isValid(String(cityZoneId))) {
      bookingFilter.cityZoneId = cityZoneId;
    }

    const bookings = await ServiceBooking.find(bookingFilter).select("_id serviceId districtId cityZoneId").lean();
    if (!bookings.length) {
      console.log("[REVALIDATE_SERVICE_COMPLETE]", { durationMs: Date.now() - startTime, bookingCount: 0, action: "NONE" });
      return { expired: 0 };
    }
    const bookingById = new Map(bookings.map((b) => [String(b._id), b]));

    const broadcasts = await JobBroadcast.find({
      bookingId: { $in: bookings.map((b) => b._id) },
      status: "sent",
      expiresAt: { $gt: new Date() },
    }).select("_id bookingId technicianId version").lean();
    if (!broadcasts.length) {
      console.log("[REVALIDATE_SERVICE_COMPLETE]", { durationMs: Date.now() - startTime, bookingCount: bookings.length, action: "NONE" });
      return { expired: 0 };
    }

    // B-18: COMPLETE technician documents — every field the eligibility
    // function consumes (status, online, skills, GPS, permissions, radius).
    const techIds = [...new Set(broadcasts.map((b) => String(b.technicianId)))];
    const techDocs = await TechnicianProfile.find({ _id: { $in: techIds } }).lean();
    const techById = new Map(techDocs.map((t) => [String(t._id), t]));

    let expired = 0;
    const toExpire = [];
    for (const broadcast of broadcasts) {
      const booking = bookingById.get(String(broadcast.bookingId));
      const tech = techById.get(String(broadcast.technicianId));
      if (!booking || !tech) continue;
      const eligibility = await evaluateTechnicianEligibility({ technician: tech, booking, mode: "BROADCAST" });
      if (!eligibility.eligible) toExpire.push({ broadcast, reasons: eligibility.reasons });
    }

    if (toExpire.length) {
      const ids = toExpire.map((e) => e.broadcast._id);
      const updateResult = await JobBroadcast.updateMany(
        { _id: { $in: ids }, status: "sent" },
        { $set: { status: "expired", expiredAt: new Date(), expiredReason: "service_disabled" } }
      );
      expired = updateResult.modifiedCount ?? toExpire.length;
      console.log("[REVALIDATE_SERVICE_ACTION]", {
        action: "EXPIRE", checkedCount: broadcasts.length, expiredCount: toExpire.length,
        matchedCount: updateResult.matchedCount, modifiedCount: updateResult.modifiedCount,
      });
      if (io) {
        for (const { broadcast } of toExpire) {
          const tech = techById.get(String(broadcast.technicianId));
          const userId = tech?.userId ? String(tech.userId) : undefined;
          emitJobExpired(io, broadcast.technicianId, {
            bookingId: broadcast.bookingId, broadcastId: broadcast._id,
            expiresAt: new Date(), reason: "service_disabled", reasons: ["SERVICE_DISABLED"], userId,
          });
          emitJobsChanged(io, broadcast.technicianId, { userId });
        }
      }
    } else {
      console.log("[REVALIDATE_SERVICE_ACTION]", { action: "KEEP", checkedCount: broadcasts.length });
    }

    console.log("[REVALIDATE_SERVICE_COMPLETE]", {
      durationMs: Date.now() - startTime, bookingCount: bookings.length,
      broadcastCount: broadcasts.length, totalExpired: expired,
    });
    return { expired };
  } catch (err) {
    console.error("[REVALIDATE_SERVICE_ERROR]", {
      serviceId: serviceId ? String(serviceId) : null,
      error: err.message, stack: err.stack, durationMs: Date.now() - startTime
    });
    return { expired: 0, error: err.message };
  }
}

/**
 * B-12 enable-direction recovery: re-run matching for recent unassigned
 * bookings in scope so newly eligible technicians receive offers.
 * Bounded (default 25, most recent first); matchAndBroadcastBooking is
 * lease-guarded and upsert-idempotent, so repeated runs never duplicate
 * offers or revive terminal broadcasts (only pending/broadcasted,
 * unassigned bookings are considered).
 */
export const AVAILABILITY_BACKFILL_LIMIT = 25;

export async function backfillBroadcastsForScope({ serviceId = null, districtId = null, cityZoneId = null, limit = AVAILABILITY_BACKFILL_LIMIT, io = null } = {}) {
  const filter = { status: { $in: ["pending", "broadcasted"] }, technicianId: null };
  if (serviceId) filter.serviceId = serviceId;
  if (districtId) filter.districtId = districtId;
  if (cityZoneId && mongoose.Types.ObjectId.isValid(String(cityZoneId))) filter.cityZoneId = cityZoneId;

  const bookings = await ServiceBooking.find(filter).sort({ createdAt: -1 }).limit(limit).select("_id").lean();
  let backfilled = 0;
  const { matchAndBroadcastBooking } = await import("./technicianMatching.js");
  for (const b of bookings) {
    try {
      const res = await matchAndBroadcastBooking(String(b._id), io);
      if (res?.success && res?.count > 0) backfilled += 1;
    } catch (err) {
      console.error("[BACKFILL_ERROR]", { bookingId: String(b._id), error: err.message });
    }
  }
  console.log("[BACKFILL_COMPLETE]", { bookingCount: bookings.length, backfilled });
  return { considered: bookings.length, backfilled };
}
