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

// Scheduled dispatch is immediate at booking. The legacy lead-hours override
// is intentionally not read; assertScheduleSlotBootConfig() rejects a nonzero
// env value in production so a deployment cannot silently restore a 24h delay.
export const SCHEDULED_DISPATCH_LEAD_HOURS = 0;

export const SCHEDULE_SLOT_MODEL = String(process.env.SCHEDULE_SLOT_MODEL || "four_slot").toLowerCase();
export const SLOT_TRAVEL_BUFFER_MINUTES = Math.max(
  0,
  Math.floor(envNumber("SLOT_TRAVEL_BUFFER_MINUTES", 30))
);
export const INSTANT_SLOT_BUFFER_MINUTES = Math.max(
  0,
  Math.floor(envNumber("INSTANT_SLOT_BUFFER_MINUTES", 15))
);
export const REPLACEMENT_SEARCH_MINUTES = Math.max(
  5,
  Math.floor(envNumber("REPLACEMENT_SEARCH_MINUTES", 35))
);
export const CUSTOMER_NO_SHOW_WAIT_MINUTES = Math.max(
  1,
  Math.floor(envNumber("CUSTOMER_NO_SHOW_WAIT_MINUTES", 15))
);
export const CUSTOMER_NO_SHOW_RESPONSE_MINUTES = Math.max(
  1,
  Math.floor(envNumber("CUSTOMER_NO_SHOW_RESPONSE_MINUTES", 10))
);
export const CUSTOMER_NO_SHOW_GEOFENCE_METERS = Math.max(
  10,
  Math.floor(envNumber("CUSTOMER_NO_SHOW_GEOFENCE_METERS", 100))
);
export const CUSTOMER_NO_SHOW_COMPENSATION_ENABLED = envBool("CUSTOMER_NO_SHOW_COMPENSATION_ENABLED", false);
export const CUSTOMER_NO_SHOW_COMPENSATION_PERCENT = Math.min(
  100,
  Math.max(0, envNumber("CUSTOMER_NO_SHOW_COMPENSATION_PERCENT", 50))
);
export const CUSTOMER_NO_SHOW_MIN_COMPENSATION_PAISE = Math.max(
  0,
  Math.floor(envNumber("CUSTOMER_NO_SHOW_MIN_COMPENSATION_PAISE", 10000))
);
export const MAX_SCHEDULED_JOBS_PER_DAY_DEFAULT = Math.max(
  1,
  Math.min(4, Math.floor(envNumber("MAX_SCHEDULED_JOBS_PER_DAY_DEFAULT", 3)))
);
export const MAX_RESCHEDULES_PER_BOOKING = Math.max(
  0,
  Math.floor(envNumber("MAX_RESCHEDULES_PER_BOOKING", 2))
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
  // Immediate dispatch for scheduled bookings. Kept as a function so callers
  // do not need to change shape; the field remains for legacy rows.
  return now;
};

export const isDispatchWindowOpen = (booking, now = new Date()) => {
  if (booking?.bookingType !== "schedule") return true;
  if (!booking?.dispatchEligibleAt) return true;
  const eligibleAt = new Date(booking.dispatchEligibleAt).getTime();
  return !Number.isFinite(eligibleAt) || eligibleAt <= now.getTime();
};

/**
 * Boot-time guard for the four-slot model.
 * - SCHEDULE_SLOT_MODEL must be legacy or four_slot.
 * - A nonzero legacy SCHEDULED_DISPATCH_LEAD_HOURS is rejected: scheduled
 *   dispatch is immediate, and silently restoring a lead would hide offers.
 * - four_slot requires transactions; production refuses to start otherwise.
 */
export const assertScheduleSlotBootConfig = ({ transactionSupported = true } = {}) => {
  if (!["legacy", "four_slot"].includes(SCHEDULE_SLOT_MODEL)) {
    throw new Error(
      `SCHEDULE_SLOT_MODEL must be "legacy" or "four_slot" (got "${SCHEDULE_SLOT_MODEL}")`
    );
  }

  const legacyLead = Number(process.env.SCHEDULED_DISPATCH_LEAD_HOURS);
  if (Number.isFinite(legacyLead) && legacyLead > 0) {
    const message =
      "SCHEDULED_DISPATCH_LEAD_HOURS is no longer supported; scheduled dispatch is immediate. Remove the env var.";
    if (process.env.NODE_ENV === "production") {
      console.error(`❌ ${message} Refusing to start.`);
      process.exit(1);
    }
    console.warn(`⚠️ ${message}`);
  }

  if (SCHEDULE_SLOT_MODEL === "four_slot" && !transactionSupported) {
    const message =
      "SCHEDULE_SLOT_MODEL=four_slot requires MongoDB transactions (replica set).";
    if (process.env.NODE_ENV === "production") {
      console.error(`❌ ${message} Refusing to start.`);
      process.exit(1);
    }
    console.warn(`⚠️ ${message} Continuing in non-production.`);
  }

  return { model: SCHEDULE_SLOT_MODEL, transactionSupported };
};
