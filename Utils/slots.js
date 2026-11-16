/**
 * 🕒 SLOT ENGINE — single authoritative source for booking slots.
 *
 * Used by BOTH the slots endpoint (GET /booking/slots) and booking creation
 * (POST /booking/schedule, cart checkout, book-again), so slot rules can never
 * drift between display and validation.
 *
 * Rules (four-slot model):
 *   - Five bookable days: tomorrow + the next four days
 *   - Four 3-hour slots: 09:00–12:00, 12:00–15:00, 15:00–18:00, 18:00–21:00
 *   - The creation endpoint rejects any slot this utility did not generate
 *   - All comparisons use the business timezone + UTC timestamps
 *
 * Legacy rows (30-minute slots) are mapped to their containing 3-hour slot by
 * getSlotForTime(), so old bookings still block the correct modern slot.
 *
 * Configure the business timezone via BUSINESS_TIMEZONE env
 * (default: Asia/Kolkata — India display convention).
 */

export const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "Asia/Kolkata";

export const SCHEDULE_DAYS = 5;
export const SLOT_DURATION_MINUTES = 180;
export const SLOT_START_HOUR = 9;
export const SLOT_END_HOUR = 21;

export const SLOT_DEFINITIONS = [
  { value: "09:00", startHour: 9, endHour: 12, startLabel: "09:00 AM", endLabel: "12:00 PM", label: "09:00 AM - 12:00 PM" },
  { value: "12:00", startHour: 12, endHour: 15, startLabel: "12:00 PM", endLabel: "03:00 PM", label: "12:00 PM - 03:00 PM" },
  { value: "15:00", startHour: 15, endHour: 18, startLabel: "03:00 PM", endLabel: "06:00 PM", label: "03:00 PM - 06:00 PM" },
  { value: "18:00", startHour: 18, endHour: 21, startLabel: "06:00 PM", endLabel: "09:00 PM", label: "06:00 PM - 09:00 PM" },
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format a Date into parts expressed in the business timezone.
 * @returns {{ year, month, day, weekday, hours, minutes, hour12, label }}
 */
export const formatInBusinessTimezone = (date, tz = BUSINESS_TIMEZONE) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    weekday: get("weekday"),
    hour12: get("hour12"),
    hours: get("hour"),
    minutes: get("minute"),
  };
};

/**
 * Local calendar date (YYYY-MM-DD) of `date` in the business timezone.
 */
export const localDateInBusinessTimezone = (date, tz = BUSINESS_TIMEZONE) => {
  const { year, month, day } = formatInBusinessTimezone(date, tz);
  return `${year}-${month}-${day}`;
};

/**
 * Build a Date for a local date + time in the business timezone.
 * @param {string} localDate "YYYY-MM-DD"
 * @param {string} localTime "HH:MM" (24h)
 * @returns {Date|null} UTC Date, or null if invalid
 */
export const localDateTimeToUtc = (localDate, localTime, tz = BUSINESS_TIMEZONE) => {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDate || ""));
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(localTime || ""));
  if (!dateMatch || !timeMatch) return null;

  const y = Number(dateMatch[1]);
  const mo = Number(dateMatch[2]);
  const d = Number(dateMatch[3]);
  const h = Number(timeMatch[1]);
  const mi = Number(timeMatch[2]);

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) return null;

  // Interpret the wall-clock time in `tz` and convert to UTC epoch.
  const asUTC = Date.UTC(y, mo - 1, d, h, mi, 0);
  const probe = new Date(asUTC);
  const offsetMinutes = tzOffsetMinutesAt(probe, tz);
  return new Date(asUTC - offsetMinutes * 60 * 1000);
};

/**
 * Timezone offset (minutes, UTC = local − offset) at a given instant for `tz`.
 */
const tzOffsetMinutesAt = (instant, tz) => {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const localEpoch = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((localEpoch - instant.getTime()) / 60000);
};

/**
 * Start of "today" in the business timezone (UTC Date).
 */
export const startOfBusinessDayUtc = (date = new Date(), tz = BUSINESS_TIMEZONE) => {
  const { year, month, day } = formatInBusinessTimezone(date, tz);
  return localDateTimeToUtc(`${year}-${month}-${day}`, "00:00", tz);
};

/**
 * All valid slot definitions (display + value).
 */
export const generateTimeSlots = () =>
  SLOT_DEFINITIONS.map((slot) => ({
    label: slot.label,
    value: slot.value,
    startTime: slot.value,
    endTime: `${String(slot.endHour).padStart(2, "0")}:00`,
    startLabel: slot.startLabel,
    endLabel: slot.endLabel,
    startHour: slot.startHour,
    endHour: slot.endHour,
  }));

/**
 * Generate the schedule day options (tomorrow + next four days in the
 * business timezone).
 * @returns {Array<{ date, month, fullDate, dayName, weekday, label }>}
 */
export const generateScheduleDays = (now = new Date(), tz = BUSINESS_TIMEZONE) => {
  const todayStart = startOfBusinessDayUtc(now, tz);
  const days = [];
  for (let i = 1; i <= SCHEDULE_DAYS; i++) {
    const d = new Date(todayStart.getTime() + i * 24 * 60 * 60 * 1000);
    const { day, month, weekday } = formatInBusinessTimezone(d, tz);
    days.push({
      date: Number(day),
      month: MONTH_NAMES[Number(month) - 1],
      fullDate: localDateInBusinessTimezone(d, tz),
      dayName: weekday,
      weekday: weekday,
      label: i === 1 ? "Tomorrow" : i === 2 ? "Day after Tomorrow" : weekday,
    });
  }
  return days;
};

/**
 * Slot availability window for booking creation:
 * { from: tomorrowStartUtc, to: day-fiveEndUtc }
 */
export const scheduleBookingWindow = (now = new Date(), tz = BUSINESS_TIMEZONE) => {
  const todayStart = startOfBusinessDayUtc(now, tz);
  const from = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000); // tomorrow 00:00
  const lastDayStart = new Date(todayStart.getTime() + SCHEDULE_DAYS * 24 * 60 * 60 * 1000);
  const to = new Date(lastDayStart.getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000 + 999);
  return { from, to };
};

/**
 * Resolve the containing modern slot for an arbitrary timestamp.
 * Legacy 30-minute bookings map to the 3-hour slot that contains them.
 *
 * @returns {{ slotKey, slotValue, slotLabel, slotStartAt, slotEndAt, localDate }|null}
 */
export const getSlotForTime = (scheduledAt, tz = BUSINESS_TIMEZONE) => {
  const date = new Date(scheduledAt);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = formatInBusinessTimezone(date, tz);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hours) * 60 + Number(parts.minutes);
  const definition = SLOT_DEFINITIONS.find(
    (slot) => minutes >= slot.startHour * 60 && minutes < slot.endHour * 60
  );
  if (!definition) return null;

  const slotStartAt = localDateTimeToUtc(localDate, definition.value, tz);
  const slotEndAt = localDateTimeToUtc(
    localDate,
    `${String(definition.endHour).padStart(2, "0")}:00`,
    tz
  );
  if (!slotStartAt || !slotEndAt) return null;

  return {
    slotKey: `${localDate}|${definition.value}`,
    slotValue: definition.value,
    slotLabel: definition.label,
    slotStartAt,
    slotEndAt,
    localDate,
  };
};

/**
 * Slot key + UTC window for a local date + exact slot start.
 */
export const getSlotWindow = (localDate, slotValue, tz = BUSINESS_TIMEZONE) => {
  const definition = SLOT_DEFINITIONS.find((slot) => slot.value === slotValue);
  if (!definition) return null;
  const slotStartAt = localDateTimeToUtc(localDate, definition.value, tz);
  const slotEndAt = localDateTimeToUtc(
    localDate,
    `${String(definition.endHour).padStart(2, "0")}:00`,
    tz
  );
  if (!slotStartAt || !slotEndAt) return null;
  return {
    slotKey: `${localDate}|${definition.value}`,
    slotValue: definition.value,
    slotLabel: definition.label,
    slotStartAt,
    slotEndAt,
    localDate,
  };
};

/**
 * VALIDATE a submitted slot exactly as the slots endpoint generates it.
 *
 * @param {string} scheduledDate "YYYY-MM-DD"
 * @param {string} scheduledTime "HH:MM"
 * @param {Object} [opts]
 * @param {Date}   [opts.now]
 * @param {string} [opts.timezone]
 * @param {number} [opts.minLeadMinutes=30] minimum lead time from now
 * @returns {{ valid: boolean, scheduledAt?: Date, slot?: object, error?: string }}
 */
export const validateSlot = (
  scheduledDate,
  scheduledTime,
  { now = new Date(), timezone = BUSINESS_TIMEZONE, minLeadMinutes = 30 } = {}
) => {
  if (!scheduledDate || !scheduledTime) {
    return { valid: false, error: "scheduledDate and scheduledTime are required" };
  }

  // 1. Slot must exist in the generated set
  const validTimes = generateTimeSlots().map((s) => s.value);
  if (!validTimes.includes(scheduledTime)) {
    return { valid: false, error: "Slot is not one of the available slots" };
  }

  // 2. Convert to UTC using the business timezone
  const scheduledAt = localDateTimeToUtc(scheduledDate, scheduledTime, timezone);
  if (!scheduledAt) {
    return { valid: false, error: "Invalid scheduledDate or scheduledTime format" };
  }

  // 3. Date must be within the five-day booking window
  const { from, to } = scheduleBookingWindow(now, timezone);
  if (scheduledAt < from || scheduledAt > to) {
    return {
      valid: false,
      error: "Scheduled bookings are only allowed within the next five days",
    };
  }

  // 4. Minimum lead time — checked against the real UTC scheduledAt
  const minFuture = new Date(now.getTime() + minLeadMinutes * 60 * 1000);
  if (scheduledAt < minFuture) {
    return {
      valid: false,
      error: `Scheduled time must be at least ${minLeadMinutes} minutes in the future`,
    };
  }

  return { valid: true, scheduledAt, slot: getSlotWindow(scheduledDate, scheduledTime, timezone) };
};

/**
 * Validate an already-resolved UTC scheduledAt (used for cart items that
 * store `scheduledAt` as ISO instead of date+time).
 *
 * New bookings must land on a modern slot boundary. Legacy timestamps are
 * normalized to the containing slot by the caller.
 */
export const validateScheduledAtUtc = (
  scheduledAt,
  { now = new Date(), timezone = BUSINESS_TIMEZONE, minLeadMinutes = 30 } = {}
) => {
  const date = new Date(scheduledAt);
  if (isNaN(date.getTime())) {
    return { valid: false, error: "Invalid scheduledAt" };
  }
  const { from, to } = scheduleBookingWindow(now, timezone);
  if (date < from || date > to) {
    return { valid: false, error: "Scheduled bookings are only allowed within the next five days" };
  }
  const minFuture = new Date(now.getTime() + minLeadMinutes * 60 * 1000);
  if (date < minFuture) {
    return { valid: false, error: `Scheduled time must be at least ${minLeadMinutes} minutes in the future` };
  }
  const slot = getSlotForTime(date, timezone);
  if (!slot) {
    return { valid: false, error: "Scheduled time is outside the bookable 09:00–21:00 window" };
  }
  const local = formatInBusinessTimezone(date, timezone);
  return {
    valid: true,
    scheduledAt: date,
    normalizedScheduledAt: slot.slotStartAt,
    slot,
    timezone,
    scheduledDateLocal: localDateInBusinessTimezone(date, timezone),
    scheduledTimeLocal: `${local.hours}:${local.minutes}`,
  };
};

/**
 * Full slot payload for GET /booking/slots.
 */
export const getBookingSchedulePayload = (now = new Date(), tz = BUSINESS_TIMEZONE, availability = null) => {
  const instantArrival = new Date(now.getTime() + 30 * 60 * 1000);
  return {
    instant: {
      label: "Instant",
      arrivalTime: instantArrival,
      displayValue: "In 30 mins",
      estimatedArrivalAt: instantArrival,
      etaGeneratedAt: now,
      note: "Estimated arrival — not a guaranteed SLA",
    },
    schedule: {
      days: generateScheduleDays(now, tz),
      timeSlots: generateTimeSlots(),
      timezone: tz,
      availability: availability || null,
    },
  };
};
