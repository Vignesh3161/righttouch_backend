import mongoose from "mongoose";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

/**
 * Internal logic to fetch jobs for a technician (shared by Controller and Socket)
 */
export const fetchTechnicianJobsInternal = async (technicianProfileId) => {
    // Explicitly cast to ensure query consistency
    const techId = new mongoose.Types.ObjectId(technicianProfileId);

    const activeJob = await ServiceBooking.findOne({
        technicianId: techId,
        status: { $in: ["accepted", "ACCEPTED", "on_the_way", "reached", "in_progress"] },
    }).select("_id status");

    if (activeJob) return [];

    const broadcasts = await JobBroadcast.find({
        technicianId: techId,
        status: { $in: ["sent"] },
        $or: [
            { expiresAt: { $gt: new Date() } },
            // Fallback for older records without expiresAt (backwards compatibility for 2 hours)
            { expiresAt: { $exists: false }, createdAt: { $gt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }
        ]
    }).select("bookingId createdAt expiresAt");

    const bookingIds = broadcasts.map(b => b.bookingId);
    console.log(`[fetchJobsInternal] Broadcasts found: ${broadcasts.length}`);

    const technician = await TechnicianProfile.findById(technicianProfileId).select("location");
    const techCoords = technician?.location?.coordinates;

    const bookings = await ServiceBooking.find({
        _id: { $in: bookingIds },
        status: { $in: ["pending", "PENDING", "SEARCHING", "requested", "broadcasted"] },
        technicianId: null,
    })
        .populate([
            { path: "serviceId", populate: { path: "categoryId" } },
            { path: "customerId", select: "fname lname mobileNumber" },
            { path: "addressId", select: "name phone addressLine city state pincode latitude longitude" },
        ])
        .sort({ createdAt: -1 });

    console.log(`[fetchJobsInternal] Bookings matching status: ${bookings.length}`);

    return bookings.map(booking => {
        const b = booking.toObject();
        let distanceKm = null;
        if (techCoords && b.location?.coordinates) {
            const [lon1, lat1] = techCoords;
            const [lon2, lat2] = b.location.coordinates;
            const R = 6371;
            const dLat = (lat2 - lat1) * (Math.PI / 180);
            const dLon = (lon2 - lon1) * (Math.PI / 180);
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            distanceKm = (R * c).toFixed(1);
        }

        const customerName = b.addressSnapshot?.name ||
            (b.customerId ? `${b.customerId.fname || ''} ${b.customerId.lname || ''}`.trim() : "Customer");

        return {
            bookingId: b._id,
            serviceName: b.serviceId?.serviceName || "Service",
            serviceType: b.serviceId?.serviceType || "General",
            description: b.serviceId?.description || "",
            duration: b.serviceId?.duration || "Flexible",
            customerName: customerName,
            customerMobile: b.customerId?.mobileNumber || "",
            address: b.addressSnapshot?.addressLine || b.address || "Location unavailable",
            city: b.addressSnapshot?.city || "",
            pincode: b.addressSnapshot?.pincode || "",
            latitude: b.location?.coordinates?.[1] || null,
            longitude: b.location?.coordinates?.[0] || null,
            distanceStr: distanceKm ? `${distanceKm} km` : "Unknown",
            technicianAmount: b.serviceId?.technicianAmount || b.technicianAmount || 0,
            service: b.serviceId || null,
            scheduledAt: b.scheduledAt,
            faultProblem: b.faultProblem,
            createdAt: b.createdAt,
            broadcastedAt: b.broadcastedAt,
            expiresAt: broadcasts.find(br => br.bookingId.toString() === b._id.toString())?.expiresAt || null
        };
    });
};
