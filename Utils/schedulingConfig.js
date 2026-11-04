import {
  BUSINESS_TIMEZONE,
  localDateInBusinessTimezone,
  localDateTimeToUtc,
  startOfBusinessDayUtc,
} from "./slots.js";

const envNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const envBool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
};

export const SCHEDULED_DISPATCH_LEAD_HOURS = Math.max(
  0,
  envNumber("SCHEDULED_DISPATCH_LEAD_HOURS", 24)
);

export const SCHEDULED_PUSH_COOLDOWN_MINUTES = Math.max(
  0,
  envNumber("SCHEDULED_PUSH_COOLDOWN_MINUTES", 180)
);

export const SCHEDULED_QUIET_START_HOUR = Math.min(
  23,
  Math.max(0, Math.floor(envNumber("SCHEDULED_QUIET_START_HOUR", 22)))
);

export const SCHEDULED_QUIET_END_HOUR = Math.min(
  23,
  Math.max(0, Math.floor(envNumber("SCHEDULED_QUIET_END_HOUR", 8)))
);

export const SCHEDULED_CANDIDATE_CAP = Math.max(
  1,
  Math.floor(envNumber("SCHEDULED_CANDIDATE_CAP", 20))
);

export const SCHEDULED_REDISPATCH_WINDOW_MINUTES = Math.max(
  5,
  Math.floor(envNumber("SCHEDULED_REDISPATCH_WINDOW_MINUTES", 30))
);

export const REOFFER_DECLINED_AFTER_MINUTES = Math.max(
  0,
  envNumber("REOFFER_DECLINED_AFTER_MINUTES", 0)
);

export const RESCHEDULE_CUTOFF_MINUTES = Math.max(
  0,
  Math.floor(envNumber("RESCHEDULE_CUTOFF_MINUTES", 300))
);

export const SLOT_AVAILABILITY_ENABLED = envBool("SLOT_AVAILABILITY_ENABLED", true);
export const BLOCK_BOOKING_WHEN_NO_SUPPLY = envBool("BLOCK_BOOKING_WHEN_NO_SUPPLY", false);

export const FEASIBILITY_CITY_SPEED_KMPH = Math.max(
  5,
  envNumber("FEASIBILITY_CITY_SPEED_KMPH", 25)
);
export const FEASIBILITY_TRAVEL_BUFFER = Math.max(
  1,
  envNumber("FEASIBILITY_TRAVEL_BUFFER", 1.15)
);
export const FEASIBILITY_GRACE_MINUTES = Math.max(
  0,
  Math.floor(envNumber("FEASIBILITY_GRACE_MINUTES", 15))
);
export const businessHour24 = (date = new Date(), tz = BUSINESS_TIMEZONE) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return Number.isFinite(hour) ? hour : 0;
};

export const isScheduledQuietHours = (
  date = new Date(),
  startHour = SCHEDULED_QUIET_START_HOUR,
  endHour = SCHEDULED_QUIET_END_HOUR
) => {
  if (startHour === endHour) return false;
  const hour = businessHour24(date);
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
};

export const nextQuietHoursEnd = (
  date = new Date(),
  endHour = SCHEDULED_QUIET_END_HOUR,
  tz = BUSINESS_TIMEZONE
) => {
  const time = `${String(endHour).padStart(2, "0")}:00`;
  let end = localDateTimeToUtc(localDateInBusinessTimezone(date, tz), time, tz);
  if (end && end.getTime() <= date.getTime()) {
    const nextDay = new Date(startOfBusinessDayUtc(date, tz).getTime() + 24 * 60 * 60 * 1000);
    end = localDateTimeToUtc(localDateInBusinessTimezone(nextDay, tz), time, tz);
  }
  return end && end.getTime() > date.getTime() ? end : date;
};

export const computeDispatchEligibleAt = (
  bookingType,
  scheduledAt,
  now = new Date()
) => {
  if (bookingType !== "schedule" || !scheduledAt) return now;
  const leadMs = SCHEDULED_DISPATCH_LEAD_HOURS * 60 * 60 * 1000;
  const eligibleAt = new Date(new Date(scheduledAt).getTime() - leadMs);
  return eligibleAt.getTime() > now.getTime() ? eligibleAt : now;
};

export const isDispatchWindowOpen = (booking, now = new Date()) => {
  if (booking?.bookingType !== "schedule") return true;
  if (!booking?.dispatchEligibleAt) return true;
  const eligibleAt = new Date(booking.dispatchEligibleAt).getTime();
  return !Number.isFinite(eligibleAt) || eligibleAt <= now.getTime();
};
