import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import { broadcastPendingJobsToTechnician } from "./technicianMatching.js";
import { geoAdd } from "./technicianGeo.js";
import { resolveZoneFromCoordinates } from "./resolveZoneFromCoordinates.js";

/**
 * Common logic to update technician location from HTTP or Socket.
 * Includes rate limiting and distance threshold checks.
 * 
 * @param {String} technicianProfileId 
 * @param {Number} latitude 
 * @param {Number} longitude 
 * @param {Object} io - Socket.io instance
 * @returns {Object} result
 */
export const handleLocationUpdate = async (technicianProfileId, latitude, longitude, io) => {
    const profile = await TechnicianProfile.findById(technicianProfileId).select("location lastMatchingAt availability workStatus trainingCompleted");
    if (!profile) throw new Error("Technician profile not found");

    // A location ping must never re-activate an ineligible technician —
    // only an explicit go-online action (already gated by workStatus) may.
    // This closes the "suspended technician self-reactivates" hole.
    const canGoOnline =
        profile.workStatus === "approved" &&
        profile.trainingCompleted === true;

    let canGoOnlineFinal = canGoOnline;
    if (canGoOnline) {
        const kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId })
            .select("verificationStatus")
            .lean();
        canGoOnlineFinal = kyc?.verificationStatus === "approved";
    }

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
                "availability.isOnline": canGoOnlineFinal,
                locationUpdatedAt: new Date(),
            }
        );
        console.log(`📍 Tech ${technicianProfileId} moved ${dist.toFixed(1)}m. Location updated${canGoOnlineFinal ? "" : " (kept offline — eligibility not met)"}.`);
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
    // during matching. Best-effort: never blocks or fails the ping handler.
    if (canGoOnlineFinal) {
        geoAdd(technicianProfileId, longitude, latitude).catch(() => {});
    }

    // 🏘 ZONE MISMATCH DETECTION — compare live location against registered zone.
    // If the technician has a cityZoneId and their ping lands outside it, flag it.
    // If they drift back inside, clear the mismatch.
    try {
        const profileWithZone = await TechnicianProfile.findById(technicianProfileId)
            .select("cityZoneId zoneMismatch")
            .lean();

        if (profileWithZone?.cityZoneId) {
            const { zone } = await resolveZoneFromCoordinates(latitude, longitude);
            const insideZone = zone && String(zone._id) === String(profileWithZone.cityZoneId);
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
        console.error("Zone mismatch check error:", zoneErr.message);
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
