import mongoose from "mongoose";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianSlot from "../Schemas/TechnicianSlot.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import { resolveOperationalCityFromCoordinates } from "./technicianMatching.js";
import { evaluateTechnicianEligibility } from "../Services/technicianEligibilityService.js";
import { getGpsState } from "./locationConfig.js";
import { bookingDeadlineFilter } from "./bookingStatus.js";
import { buildJobScheduleFields, resolveBookingJobLocation } from "./jobPayload.js";

/**
 * Internal logic to fetch jobs for a technician (shared by Controller and Socket)
 * Enforces strict current distance (<= 10km), service availability, and fresh GPS.
 * Uses unified eligibility engine for consistency with broadcast/accept.
 */
export const fetchTechnicianJobsInternal = async (technicianProfileId) => {
    const techId = new mongoose.Types.ObjectId(technicianProfileId);

    // 1. Busy check: only current work and accepted instant jobs hide the feed.
    const activeJob = await ServiceBooking.findOne({
        technicianId: techId,
        $or: [
            { status: { $in: ["on_the_way", "reached", "in_progress"] } },
            { status: { $in: ["accepted", "ACCEPTED"] }, bookingType: "instant" },
        ],
    }).select("_id status bookingType");

    if (activeJob) return [];

    // 2. Fetch current technician profile and state
    const technician = await TechnicianProfile.findById(technicianProfileId)
        .select("location locationUpdatedAt serviceBaseLocation availability notificationPreferences workStatus profileComplete trainingCompleted primaryDistrictId primaryCityId enabledDistrictIds allowedCityIds enabledCityZoneIds skills serviceRadiusKm")
        .lean();

    if (!technician || technician.workStatus !== "approved" || !technician.availability?.isOnline) {
        return [];
    }

    // 3. Location validity & freshness gate (<= 90s for fetch).
    // A stable service base location is enough for scheduled offers; instant
    // offers are still filtered per-booking by the eligibility engine.
    const baseCoords = technician.serviceBaseLocation?.coordinates;
    const hasBaseLocation = Array.isArray(baseCoords)
        && baseCoords.length === 2
        && Number.isFinite(baseCoords[0])
        && Number.isFinite(baseCoords[1]);
    if (!hasBaseLocation) {
        const techCoords = technician.location?.coordinates;
        if (!Array.isArray(techCoords) || techCoords.length < 2 || !Number.isFinite(techCoords[0]) || !Number.isFinite(techCoords[1])) {
            console.log(`[fetchJobsInternal] Tech ${technicianProfileId} has invalid/missing GPS coordinates. Hiding jobs.`);
            return [];
        }

        const gps = getGpsState(technician, "FETCH");
        if (!gps.valid) {
            console.log(`[fetchJobsInternal] Tech ${technicianProfileId} has invalid/missing GPS coordinates. Hiding jobs.`);
            return [];
        }
        if (!gps.fresh) {
            console.log(`[fetchJobsInternal] Tech ${technicianProfileId} GPS is stale or missing timestamp (${technician.locationUpdatedAt || "none"}, reason=${gps.reason}, age=${gps.ageSeconds}s, threshold=${gps.thresholdSeconds}s). Hiding jobs.`);
            return [];
        }
    }

    const kyc = await TechnicianKyc.findOne({ technicianId: techId })
        .select("verificationStatus bankVerified bankVerificationStatus kycVerified")
        .lean();

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

    const now = new Date();
    const activeSlots = await TechnicianSlot.find({
        technicianId: techId,
        active: true,
        slotEndAt: { $gt: now },
    }).select("slotKey slotStartAt slotEndAt role bookingId").lean();
    const committedSlotKeys = new Set(activeSlots.map((slot) => String(slot.slotKey)));
    const currentSlot = activeSlots.find(
        (slot) => new Date(slot.slotStartAt) <= now && new Date(slot.slotEndAt) > now
    );
    const backupBookingIds = new Set(
        activeSlots
            .filter((slot) => slot.role === "backup" && slot.bookingId)
            .map((slot) => String(slot.bookingId))
    );

    const bookingIds = broadcasts.map(b => b.bookingId);

    // 5. Query candidate unassigned bookings
    const bookings = await ServiceBooking.find({
        _id: { $in: bookingIds },
        $and: [
            {
                $or: [
                    {
                        status: { $in: ["pending", "broadcasted"] },
                        technicianId: null,
                        dispatchEligibleAt: { $not: { $gt: new Date() } },
                    },
                    {
                        _id: { $in: [...backupBookingIds].map((id) => new mongoose.Types.ObjectId(id)) },
                        status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
                    },
                ],
            },
            bookingDeadlineFilter(),
        ],
    })
        .populate([
            { path: "serviceId", populate: { path: "categoryId" } },
            { path: "customerId", select: "fname lname mobileNumber" },
            { path: "addressId", select: "name phone addressLine city state pincode latitude longitude" },
        ])
        .sort({ createdAt: -1 })
        .lean();

    const validJobs = [];

    for (const booking of bookings) {
        const bookingIdStr = String(booking._id);
        const isBackupOffer = backupBookingIds.has(bookingIdStr);

        if (booking.bookingType === "schedule" &&
            technician.notificationPreferences?.scheduledOffersEnabled === false) {
            continue;
        }

        if (!isBackupOffer && booking.bookingType === "schedule" && booking.slotKey &&
            committedSlotKeys.has(String(booking.slotKey))) {
            continue;
        }
        if (booking.bookingType === "instant" && currentSlot) {
            continue;
        }

        // Use unified eligibility check for fetch mode (same as broadcast)
        const eligibility = await evaluateTechnicianEligibility({
            technician,
            booking: isBackupOffer ? { ...booking, technicianId: null } : booking,
            mode: "BROADCAST",
            context: { technicianKyc: kyc },
        });

        if (!eligibility.eligible) {
            console.log(`[fetchJobsInternal] 🚫 EXCLUDED job:`, {
                technicianId: String(techId),
                bookingId: bookingIdStr,
                reasons: eligibility.reasons,
                distanceMeters: eligibility.details.distanceMeters,
                effectiveRadiusMeters: eligibility.details.effectiveRadiusMeters,
            });
            continue;
        }

        // All checks passed -> Eligible for display in Jobs.jsx
        const distanceMeters = eligibility.details.distanceMeters;
        const distanceKm = distanceMeters != null ? (distanceMeters / 1000).toFixed(1) : null;
        const customerName = booking.addressSnapshot?.name ||
            (booking.customerId ? `${booking.customerId.fname || ''} ${booking.customerId.lname || ''}`.trim() : "Customer");

        const broadcastRow = broadcasts.find(br => String(br.bookingId) === bookingIdStr);
        const jobLocation = resolveBookingJobLocation(booking);

        validJobs.push({
            bookingId: booking._id,
            ...buildJobScheduleFields(booking),
            serviceName: booking.serviceId?.serviceName || "Service",
            serviceType: booking.serviceId?.serviceType || "General",
            description: booking.serviceId?.description || "",
            duration: booking.serviceId?.duration || "Flexible",
            customerName: customerName,
            customerMobile: booking.customerId?.mobileNumber || jobLocation.customerMobile || "",
            address: jobLocation.address,
            city: jobLocation.city,
            state: jobLocation.state,
            pincode: jobLocation.pincode,
            latitude: jobLocation.latitude,
            longitude: jobLocation.longitude,
            distanceStr: distanceKm != null ? `${distanceKm} km` : null,
            distanceKm: distanceKm != null ? Number(distanceKm) : null,
            distanceMeters: distanceMeters != null ? Math.round(distanceMeters) : null,
            jobRadiusKm: Number((eligibility.details.effectiveRadiusMeters / 1000).toFixed(1)),
            maxRadiusKm: Number((eligibility.details.effectiveRadiusMeters / 1000).toFixed(1)),
            maxAllowedMeters: eligibility.details.effectiveRadiusMeters,
            technicianAmount: booking.serviceId?.technicianAmount || booking.technicianAmount || 0,
            service: booking.serviceId || null,
            faultProblem: booking.faultProblem,
            createdAt: booking.createdAt,
            broadcastedAt: booking.broadcastedAt,
            version: broadcastRow?.version || 1,
            expiresAt: broadcastRow?.expiresAt || null,
            isBackupOffer,
            bookingStatus: booking.status,
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
