import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import TechnicianSlot from "../Schemas/TechnicianSlot.js";
import SlotHold from "../Schemas/SlotHold.js";
import Service from "../Schemas/Service.js";
import {
  BUSINESS_TIMEZONE,
  generateScheduleDays,
  generateTimeSlots,
  getSlotWindow,
  scheduleBookingWindow,
  SLOT_DURATION_MINUTES,
} from "../Utils/slots.js";
import { haversineMeters } from "../Utils/feasibility.js";
import {
  getEffectiveRadiusMeters,
  getTechnicianOrigin,
} from "./technicianEligibilityService.js";
import {
  SLOT_AVAILABILITY_ENABLED,
  BLOCK_BOOKING_WHEN_NO_SUPPLY,
  SLOT_TRAVEL_BUFFER_MINUTES,
  MAX_SCHEDULED_JOBS_PER_DAY_DEFAULT,
} from "../Utils/schedulingConfig.js";

const CACHE_TTL_MS = 30 * 1000;
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

/**
 * Eligibility is deliberately independent of availability.isOnline: scheduled
 * offers may be pushed while offline. Online presence only gates instant work.
 */
export const findEligibleTechnicianIds = async ({
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
    .limit(1000)
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

export const countEligibleTechniciansForSlot = async ({
  serviceId,
  districtId = null,
  cityZoneId = null,
  latitude = null,
  longitude = null,
}) => {
  const ids = await findEligibleTechnicianIds({
    serviceId,
    districtId,
    cityZoneId,
    latitude,
    longitude,
  });
  return ids.length;
};

export const assertServiceFitsSlot = (durationMinutes) => {
  const duration = Number(durationMinutes) > 0 ? Number(durationMinutes) : DEFAULT_DURATION_MINUTES;
  const required = duration + SLOT_TRAVEL_BUFFER_MINUTES;
  if (required > SLOT_DURATION_MINUTES) {
    const error = new Error(
      `This service takes ${duration} minutes plus a ${SLOT_TRAVEL_BUFFER_MINUTES}-minute travel buffer, which exceeds the 3-hour scheduled slot. Book it as an instant service instead.`
    );
    error.statusCode = 400;
    error.code = "SERVICE_DURATION_EXCEEDS_SLOT";
    throw error;
  }
  return true;
};

const countConfirmedSlots = async (slotKeys, techIds) => {
  if (!slotKeys.length || !techIds.length) return new Map();
  const rows = await TechnicianSlot.find({
    slotKey: { $in: slotKeys },
    active: true,
    technicianId: { $in: techIds.map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .select("slotKey technicianId")
    .lean();
  const bySlot = new Map();
  for (const row of rows) {
    if (!bySlot.has(row.slotKey)) bySlot.set(row.slotKey, new Set());
    bySlot.get(row.slotKey).add(String(row.technicianId));
  }
  return bySlot;
};

const countActiveHolds = async (slotKeys, serviceId, districtId, cityZoneId) => {
  if (!slotKeys.length) return new Map();
  const query = {
    slotKey: { $in: slotKeys },
    active: true,
    status: "held",
    serviceId: new mongoose.Types.ObjectId(serviceId),
  };
  if (districtId && mongoose.Types.ObjectId.isValid(districtId)) {
    query.districtId = new mongoose.Types.ObjectId(districtId);
  }
  if (cityZoneId && mongoose.Types.ObjectId.isValid(cityZoneId)) {
    query.cityZoneId = new mongoose.Types.ObjectId(cityZoneId);
  }
  const rows = await SlotHold.aggregate([
    { $match: query },
    { $group: { _id: "$slotKey", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
};

/**
 * Indicative supply for the five bookable days. Zero supply is surfaced to
 * the client; booking creation separately hard-blocks when no eligible
 * technician exists (NO_ELIGIBLE_TECHNICIAN) or the slot is full (SLOT_BUSY).
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
  const fits = durationMinutes + SLOT_TRAVEL_BUFFER_MINUTES <= SLOT_DURATION_MINUTES;

  const techIds = await findEligibleTechnicianIds({
    serviceId,
    districtId,
    cityZoneId,
    latitude,
    longitude,
  });
  const { from, to } = scheduleBookingWindow(now, tz);
  const days = generateScheduleDays(now, tz);
  const slotKeys = [];
  for (const day of days) {
    for (const slot of generateTimeSlots()) {
      slotKeys.push(`${day.fullDate}|${slot.value}`);
    }
  }

  const [confirmedBySlot, holdsBySlot] = await Promise.all([
    countConfirmedSlots(slotKeys, techIds),
    countActiveHolds(slotKeys, serviceId, districtId, cityZoneId),
  ]);

  const dayMap = {};
  let totalAvailableSlots = 0;
  for (const day of days) {
    const daySlots = {};
    for (const slot of generateTimeSlots()) {
      const window = getSlotWindow(day.fullDate, slot.value, tz);
      if (!window || window.slotStartAt < from || window.slotStartAt > to) continue;
      const slotKey = window.slotKey;
      const confirmed = confirmedBySlot.get(slotKey)?.size || 0;
      const holds = holdsBySlot.get(slotKey) || 0;
      const count = fits ? Math.max(0, techIds.length - confirmed - holds) : 0;
      if (count > 0) totalAvailableSlots += 1;
      daySlots[slot.value] = {
        slotKey,
        slotStartAt: window.slotStartAt,
        slotEndAt: window.slotEndAt,
        label: slot.label,
        technicianCount: count,
        availability: availabilityLabel(count),
        ...(fits ? {} : { reason: "SERVICE_DURATION_EXCEEDS_SLOT" }),
      };
    }
    dayMap[day.fullDate] = daySlots;
  }

  const value = {
    enabled: true,
    generatedAt: now.toISOString(),
    serviceId: String(serviceId),
    districtId: districtId ? String(districtId) : null,
    cityZoneId: cityZoneId ? String(cityZoneId) : null,
    technicianCount: techIds.length,
    maxScheduledJobsPerDay: MAX_SCHEDULED_JOBS_PER_DAY_DEFAULT,
    totalAvailableSlots,
    available: fits && techIds.length > 0 && totalAvailableSlots > 0,
    blocking: BLOCK_BOOKING_WHEN_NO_SUPPLY,
    limitedThreshold: LIMITED_THRESHOLD,
    days: dayMap,
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
