import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianLocationHistory from "../Schemas/TechnicianLocationHistory.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import { broadcastPendingJobsToTechnician } from "./technicianMatching.js";
import { geoAdd } from "./technicianGeo.js";
import { resolveZoneFromCoordinates } from "./resolveZoneFromCoordinates.js";
import { getDistrictFromCoordinates } from "../Services/districtService.js";
import { recordLocationUpdate } from "./socketMetrics.js";
import { evaluateTechnicianEligibility } from "../Services/technicianEligibilityService.js";
import { emitJobExpired, emitJobsChanged } from "./sendNotification.js";

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

    // 🏘 ZONE & DISTRICT RESOLUTION — resolve current physical district and zone from live GPS
    try {
        const { zone: currentZone } = await resolveZoneFromCoordinates(latitude, longitude);
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

    // 🔄 REVALIDATE ACTIVE BROADCASTS — if technician moved, check if they're still
    // eligible for previously broadcast jobs. Expire ones they no longer qualify for.
    if (significantMove && isOnlineNow) {
      await revalidateActiveBroadcasts(technicianProfileId, latitude, longitude, io);
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
 */
async function revalidateActiveBroadcasts(technicianProfileId, latitude, longitude, io) {
  try {
    // Get active broadcasts for this technician
    const broadcasts = await JobBroadcast.find({
      technicianId: technicianProfileId,
      status: "sent",
      expiresAt: { $gt: new Date() },
    }).select("bookingId version").lean();

    if (!broadcasts.length) return;

    // Get technician profile with all fields needed for eligibility check
    const tech = await TechnicianProfile.findById(technicianProfileId).lean();
    if (!tech) return;

    // Get bookings for these broadcasts
    const bookingIds = broadcasts.map(b => b.bookingId);
    const bookings = await ServiceBooking.find({
      _id: { $in: bookingIds },
      status: { $in: ["pending", "broadcasted"] },
      technicianId: null,
    }).lean();

    if (!bookings.length) return;

    const bookingById = new Map(bookings.map(b => [String(b._id), b]));
    const expiredBroadcastIds = [];

    for (const broadcast of broadcasts) {
      const booking = bookingById.get(String(broadcast.bookingId));
      if (!booking) continue;

      // Check eligibility with current location
      const eligibility = await evaluateTechnicianEligibility({
        technician: tech,
        booking,
        mode: "BROADCAST",
      });

      if (!eligibility.eligible) {
        expiredBroadcastIds.push(broadcast.bookingId);
        console.log(`[REVALIDATE] Expired broadcast for tech ${technicianProfileId}, booking ${broadcast.bookingId}: ${eligibility.reasons.join(", ")}`);
      }
    }

    if (expiredBroadcastIds.length > 0) {
      // Expire the broadcasts
      await JobBroadcast.updateMany(
        { bookingId: { $in: expiredBroadcastIds }, technicianId: technicianProfileId },
        { $set: { status: "expired" } }
      );

      // Notify technician via socket that jobs are no longer available
      if (io) {
        for (const bookingId of expiredBroadcastIds) {
          emitJobExpired(io, technicianProfileId, { 
            bookingId, 
            expiresAt: new Date(), 
            reason: "no_longer_eligible" 
          });
        }
        // Also emit jobs_changed to trigger feed refresh
        emitJobsChanged(io, technicianProfileId);
      }
    }
  } catch (err) {
    console.error(`[REVALIDATE] Error revalidating broadcasts for tech ${technicianProfileId}:`, err.message);
  }
}
