import mongoose from "mongoose";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { haversineMeters } from "./feasibility.js";
import { resolveServiceAvailability } from "../Services/serviceAvailabilityService.js";
import { resolveOperationalCityFromCoordinates } from "./technicianMatching.js";

const STALENESS_SECONDS = (() => {
  const raw = Number(process.env.LOCATION_STALENESS_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
})();

/**
 * Internal logic to fetch jobs for a technician (shared by Controller and Socket)
 * Enforces strict current distance (<= 10km), service availability, and fresh GPS.
 */
export const fetchTechnicianJobsInternal = async (technicianProfileId) => {
    const techId = new mongoose.Types.ObjectId(technicianProfileId);

    // 1. Busy check: technician cannot see/accept new jobs if currently working on a job
    const activeJob = await ServiceBooking.findOne({
        technicianId: techId,
        status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
    }).select("_id status");

    if (activeJob) return [];

    // 2. Fetch current technician profile and state
    const technician = await TechnicianProfile.findById(technicianProfileId)
        .select("location locationUpdatedAt availability workStatus primaryDistrictId primaryCityId enabledDistrictIds allowedCityIds enabledCityZoneIds skills serviceRadiusKm")
        .lean();

    if (!technician || technician.workStatus !== "approved" || !technician.availability?.isOnline) {
        return [];
    }

    // 3. Location validity & freshness gate (<= 90s)
    const techCoords = technician.location?.coordinates;
    if (!Array.isArray(techCoords) || techCoords.length < 2 || !Number.isFinite(techCoords[0]) || !Number.isFinite(techCoords[1])) {
        return [];
    }

    if (STALENESS_SECONDS > 0 && technician.locationUpdatedAt) {
        const cutoff = new Date(Date.now() - STALENESS_SECONDS * 1000);
        if (new Date(technician.locationUpdatedAt) < cutoff) {
            console.log(`[fetchJobsInternal] Tech ${technicianProfileId} GPS is stale (${technician.locationUpdatedAt}). Hiding jobs.`);
            return [];
        }
    }

    // 4. Find active unexpired broadcasts
    const broadcasts = await JobBroadcast.find({
        technicianId: techId,
        status: { $in: ["sent"] },
        $or: [
            { expiresAt: { $gt: new Date() } },
            { expiresAt: { $exists: false }, createdAt: { $gt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }
        ]
    }).select("bookingId createdAt expiresAt version").lean();

    if (!broadcasts.length) return [];

    const bookingIds = broadcasts.map(b => b.bookingId);

    // 5. Query candidate unassigned bookings
    const bookings = await ServiceBooking.find({
        _id: { $in: bookingIds },
        status: { $in: ["pending", "broadcasted"] },
        technicianId: null,
    })
        .populate([
            { path: "serviceId", populate: { path: "categoryId" } },
            { path: "customerId", select: "fname lname mobileNumber" },
            { path: "addressId", select: "name phone addressLine city state pincode latitude longitude" },
        ])
        .sort({ createdAt: -1 })
        .lean();

    // Prepare allowed district set
    const allowedDistricts = [
        technician.primaryDistrictId,
        technician.primaryCityId,
        ...(technician.enabledDistrictIds || []),
        ...(technician.allowedCityIds || []),
    ].filter(Boolean).map(String);

    const allowedZones = (technician.enabledCityZoneIds || []).map(String);
    const techSkills = (technician.skills || []).map(s => String(s.serviceId?._id || s.serviceId));

    const validJobs = [];
    const maxRadiusMeters = 10000; // Strict 10 KM limit

    for (const booking of bookings) {
        const bookingIdStr = String(booking._id);
        const serviceIdStr = String(booking.serviceId?._id || booking.serviceId);

        // 6A. CURRENT DISTANCE RECALCULATION (Haversine: Tech GPS -> Customer GPS)
        const customerLocation = booking.location?.coordinates || 
            (booking.addressSnapshot ? [booking.addressSnapshot.longitude, booking.addressSnapshot.latitude] : null);

        if (!customerLocation) {
            continue;
        }

        const distanceMeters = haversineMeters(technician.location, customerLocation);

        if (distanceMeters == null || distanceMeters > maxRadiusMeters) {
            console.log(`[fetchJobsInternal] 🚫 EXCLUDED out-of-radius job:`, {
                technicianId: String(techId),
                bookingId: bookingIdStr,
                distanceMeters: Math.round(distanceMeters || 0),
                maxAllowedMeters: maxRadiusMeters,
                techCoords: technician.location?.coordinates,
                customerCoords: customerLocation,
                reason: "RADIUS_EXCEEDED"
            });
            continue;
        }

        // 6B. SERVICE AVAILABILITY REVALIDATION (Zone-level takes priority over district)
        let targetDistrictId = booking.districtId ? String(booking.districtId._id || booking.districtId) : null;
        let targetCityZoneId = booking.cityZoneId ? String(booking.cityZoneId._id || booking.cityZoneId) : null;

        if (!targetDistrictId && customerLocation && customerLocation.length === 2) {
            const [custLng, custLat] = customerLocation;
            if (Number.isFinite(custLat) && Number.isFinite(custLng)) {
                const resolvedCity = await resolveOperationalCityFromCoordinates(custLat, custLng);
                if (resolvedCity?._id) targetDistrictId = String(resolvedCity._id);
            }
        }

        const avail = await resolveServiceAvailability({
            serviceId: serviceIdStr,
            districtId: targetDistrictId,
            cityZoneId: targetCityZoneId,
        });

        if (!avail.available) {
            console.log(`[fetchJobsInternal] 🚫 EXCLUDED unavailable service job:`, {
                technicianId: String(techId),
                bookingId: bookingIdStr,
                serviceId: serviceIdStr,
                districtId: targetDistrictId,
                cityZoneId: targetCityZoneId,
                reason: avail.reason,
            });
            continue;
        }

        // 6C. DISTRICT PERMISSION CHECK
        if (targetDistrictId) {
            if (allowedDistricts.length > 0 && !allowedDistricts.includes(targetDistrictId)) {
                console.log(`[fetchJobsInternal] 🚫 EXCLUDED district permission denied:`, { bookingId: bookingIdStr, districtId: targetDistrictId });
                continue;
            }
        }

        // 6D. ZONE PERMISSION CHECK
        if (booking.cityZoneId) {
            const zoneStr = String(booking.cityZoneId._id || booking.cityZoneId);
            if (allowedZones.length > 0 && !allowedZones.includes(zoneStr)) {
                console.log(`[fetchJobsInternal] 🚫 EXCLUDED zone permission denied:`, { bookingId: bookingIdStr, cityZoneId: zoneStr });
                continue;
            }
        }

        // 6E. SKILL MATCH CHECK
        if (techSkills.length > 0 && !techSkills.includes(serviceIdStr)) {
            console.log(`[fetchJobsInternal] 🚫 EXCLUDED skill missing:`, { bookingId: bookingIdStr, serviceId: serviceIdStr });
            continue;
        }

        // All checks passed -> Eligible for display in Jobs.jsx
        const distanceKm = (distanceMeters / 1000).toFixed(1);
        const customerName = booking.addressSnapshot?.name ||
            (booking.customerId ? `${booking.customerId.fname || ''} ${booking.customerId.lname || ''}`.trim() : "Customer");

        const broadcastRow = broadcasts.find(br => String(br.bookingId) === bookingIdStr);

        validJobs.push({
            bookingId: booking._id,
            serviceName: booking.serviceId?.serviceName || "Service",
            serviceType: booking.serviceId?.serviceType || "General",
            description: booking.serviceId?.description || "",
            duration: booking.serviceId?.duration || "Flexible",
            customerName: customerName,
            customerMobile: booking.customerId?.mobileNumber || "",
            address: booking.addressSnapshot?.addressLine || booking.address || "Location unavailable",
            city: booking.addressSnapshot?.city || "",
            pincode: booking.addressSnapshot?.pincode || "",
            latitude: booking.location?.coordinates?.[1] || null,
            longitude: booking.location?.coordinates?.[0] || null,
            distanceStr: `${distanceKm} km`,
            distanceKm: Number(distanceKm),
            distanceMeters: Math.round(distanceMeters),
            jobRadiusKm: 10,
            maxRadiusKm: 10,
            maxAllowedMeters: maxRadiusMeters,
            technicianAmount: booking.serviceId?.technicianAmount || booking.technicianAmount || 0,
            service: booking.serviceId || null,
            scheduledAt: booking.scheduledAt,
            faultProblem: booking.faultProblem,
            createdAt: booking.createdAt,
            broadcastedAt: booking.broadcastedAt,
            version: broadcastRow?.version || 1,
            expiresAt: broadcastRow?.expiresAt || null
        });
    }

    if (validJobs.length > 0) {
        console.log(`[fetchJobsInternal] ✅ Found ${validJobs.length} eligible job(s) within 10km radius for tech ${techId}:`);
        validJobs.forEach((job, idx) => {
            console.log(`   📍 Job [${idx + 1}]: ID ${job.bookingId} (${job.serviceName}) | Distance: ${job.distanceStr} (Radius: 10 km limit)`);
        });
    } else {
        console.log(`[fetchJobsInternal] Returning 0 eligible jobs within 10km for tech ${techId}`);
    }
    return validJobs;
};
