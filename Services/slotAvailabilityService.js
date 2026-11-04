import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import Service from "../Schemas/Service.js";
import {
  BUSINESS_TIMEZONE,
  generateScheduleDays,
  generateTimeSlots,
  localDateTimeToUtc,
  scheduleBookingWindow,
} from "../Utils/slots.js";
import { haversineMeters } from "../Utils/feasibility.js";
import {
  getEffectiveRadiusMeters,
  getTechnicianOrigin,
} from "./technicianEligibilityService.js";
import {
  SLOT_AVAILABILITY_ENABLED,
  BLOCK_BOOKING_WHEN_NO_SUPPLY,
} from "../Utils/schedulingConfig.js";

const CACHE_TTL_MS = 30 * 1000;
const BUSY_BUFFER_MS = 15 * 60 * 1000;
const DEFAULT_DURATION_MINUTES = 60;
const LIMITED_THRESHOLD = 3;

const cache = new Map();

const cacheKey = ({ serviceId, districtId, cityZoneId, latitude, longitude, now }) =>
  `${serviceId}|${districtId || "-"}|${cityZoneId || "-"}|${Number(latitude ?? 0).toFixed(3)}|${Number(longitude ?? 0).toFixed(3)}|${new Date(now).toISOString().slice(0, 13)}`;

const availabilityLabel = (count) => {
  if (count <= 0) return "UNAVAILABLE";
  if (count < LIMITED_THRESHOLD) return "LIMITED";
  return "AVAILABLE";
};

const findEligibleTechnicianIds = async ({
  serviceId,
  districtId,
  cityZoneId,
  latitude = null,
  longitude = null,
}) => {
  const serviceObjectId = mongoose.Types.ObjectId.isValid(serviceId)
    ? new mongoose.Types.ObjectId(serviceId)
    : null;
  if (!serviceObjectId) return [];

  const query = {
    workStatus: "approved",
    profileComplete: true,
    trainingCompleted: true,
    "notificationPreferences.scheduledOffersEnabled": { $ne: false },
    $or: [
      { "skills.serviceId": serviceObjectId },
      { "skills.serviceId": String(serviceId) },
    ],
  };

  if (districtId && mongoose.Types.ObjectId.isValid(districtId)) {
    const districtObjectId = new mongoose.Types.ObjectId(districtId);
    query.$and = [
      {
        $or: [
          { enabledDistrictIds: districtObjectId },
          { allowedCityIds: districtObjectId },
        ],
      },
    ];
  }

  if (cityZoneId && mongoose.Types.ObjectId.isValid(cityZoneId)) {
    query.$and = query.$and || [];
    query.$and.push({
      enabledCityZoneIds: new mongoose.Types.ObjectId(cityZoneId),
    });
  }

  const technicians = await TechnicianProfile.find(query)
    .select("_id serviceBaseLocation location serviceRadiusKm")
    .limit(500)
    .lean();
  if (!technicians.length) return [];

  const hasJobCoords = Number.isFinite(latitude) && Number.isFinite(longitude);
  const withinRadius = hasJobCoords
    ? technicians.filter((technician) => {
      const origin = getTechnicianOrigin(technician, "schedule");
      if (!origin?.location?.coordinates) return false;
      const distance = haversineMeters(origin.location, { latitude, longitude });
      return distance != null && distance <= getEffectiveRadiusMeters(technician);
    })
    : technicians;
  if (!withinRadius.length) return [];

  const techIds = withinRadius.map((t) => t._id);
  const kyc = await TechnicianKyc.find({
    technicianId: { $in: techIds },
    $and: [
      { $or: [{ verificationStatus: "approved" }, { kycVerified: true }] },
      { $or: [{ bankVerified: true }, { bankVerificationStatus: "approved" }] },
    ],
  })
    .select("technicianId")
    .lean();

  const approved = new Set(kyc.map((k) => String(k.technicianId)));
  return techIds.map(String).filter((id) => approved.has(id));
};

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * Indicative supply for the two bookable days. This is intentionally soft:
 * zero supply is surfaced to the client but does not block booking unless the
 * caller explicitly opts into BLOCK_BOOKING_WHEN_NO_SUPPLY.
 */
export const getSlotAvailability = async ({
  serviceId,
  districtId = null,
  cityZoneId = null,
  latitude = null,
  longitude = null,
  now = new Date(),
  tz = BUSINESS_TIMEZONE,
} = {}) => {
  if (!SLOT_AVAILABILITY_ENABLED || !serviceId) return null;
  if (!mongoose.Types.ObjectId.isValid(serviceId)) return null;

  const key = cacheKey({ serviceId, districtId, cityZoneId, latitude, longitude, now });
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const service = await Service.findById(serviceId)
    .select("durationMinutes")
    .lean();
  if (!service) return null;

  const durationMinutes = Number(service.durationMinutes) > 0
    ? Number(service.durationMinutes)
    : DEFAULT_DURATION_MINUTES;
  const durationMs = durationMinutes * 60 * 1000;

  const techIds = await findEligibleTechnicianIds({
    serviceId,
    districtId,
    cityZoneId,
    latitude,
    longitude,
  });
  const { from, to } = scheduleBookingWindow(now, tz);

  let bookings = [];
  if (techIds.length) {
    bookings = await ServiceBooking.find({
      technicianId: { $in: techIds.map((id) => new mongoose.Types.ObjectId(id)) },
      bookingType: "schedule",
      status: {
        $in: ["accepted", "ACCEPTED", "on_the_way", "reached", "in_progress"],
      },
      scheduledAt: {
        $gte: new Date(from.getTime() - 8 * 60 * 60 * 1000),
        $lte: new Date(to.getTime() + 8 * 60 * 60 * 1000),
      },
    })
      .select("technicianId scheduledAt estimatedDurationMinutes")
      .lean();
  }

  const busyByTech = new Map();
  for (const booking of bookings) {
    const techId = String(booking.technicianId);
    const start = new Date(booking.scheduledAt).getTime();
    if (!Number.isFinite(start)) continue;
    const bookingDuration = Number(booking.estimatedDurationMinutes) > 0
      ? Number(booking.estimatedDurationMinutes)
      : DEFAULT_DURATION_MINUTES;
    const end = start + bookingDuration * 60 * 1000 + BUSY_BUFFER_MS;
    if (!busyByTech.has(techId)) busyByTech.set(techId, []);
    busyByTech.get(techId).push([start - BUSY_BUFFER_MS, end]);
  }

  const days = {};
  let totalAvailableSlots = 0;
  for (const day of generateScheduleDays(now, tz)) {
    const daySlots = {};
    for (const slot of generateTimeSlots()) {
      const slotStart = localDateTimeToUtc(day.fullDate, slot.value, tz);
      if (!slotStart || slotStart.getTime() <= now.getTime()) continue;
      const slotEnd = slotStart.getTime() + durationMs + BUSY_BUFFER_MS;
      const startMs = slotStart.getTime();
      let count = 0;
      for (const techId of techIds) {
        const intervals = busyByTech.get(techId) || [];
        const busy = intervals.some(([busyStart, busyEnd]) =>
          overlaps(startMs, slotEnd, busyStart, busyEnd)
        );
        if (!busy) count += 1;
      }
      if (count > 0) totalAvailableSlots += 1;
      daySlots[slot.value] = {
        technicianCount: count,
        availability: availabilityLabel(count),
      };
    }
    days[day.fullDate] = daySlots;
  }

  const value = {
    enabled: true,
    generatedAt: now.toISOString(),
    serviceId: String(serviceId),
    districtId: districtId ? String(districtId) : null,
    cityZoneId: cityZoneId ? String(cityZoneId) : null,
    technicianCount: techIds.length,
    totalAvailableSlots,
    available: techIds.length > 0 && totalAvailableSlots > 0,
    blocking: BLOCK_BOOKING_WHEN_NO_SUPPLY,
    limitedThreshold: LIMITED_THRESHOLD,
    days,
  };

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > 500) {
    for (const [cacheEntryKey, entry] of cache) {
      if (entry.expiresAt <= Date.now()) cache.delete(cacheEntryKey);
    }
  }
  return value;
};

export const clearSlotAvailabilityCache = () => cache.clear();
