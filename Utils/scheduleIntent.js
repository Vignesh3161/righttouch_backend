/**
 * 🕒 SCHEDULE INTENT NORMALIZER
 *
 * Normalizes every supported client shape into the canonical schedule object
 * consumed by booking creation:
 *
 *   { bookingType, scheduledAt, slotKey, slotValue, slotLabel, ... }
 *
 * Supported inputs:
 *   - Canonical: scheduledDate + scheduledTime
 *   - Aliases:   bookingDate/date + timeSlot/slot
 *   - ISO:       scheduledAt
 *   - Display:   scheduledSlot / slotLabel such as
 *                "17 Nov, 09:00 AM" or "Tomorrow, 17 Nov, 09:00 AM"
 *
 * Display dates are resolved ONLY against the current five bookable days.
 * Anything ambiguous or outside the slot engine window fails closed.
 */

import {
  BUSINESS_TIMEZONE,
  generateScheduleDays,
  getScheduleDaysCount,
  localDateTimeToUtc,
  localDateInBusinessTimezone,
  formatInBusinessTimezone,
  validateScheduledAtUtc,
} from "./slots.js";

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAYS = {
  sunday: "Sun",
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
};

const INSTANT_MARKERS = [
  /^in\s+\d+\s*(?:min|mins|minute|minutes)$/i,
  /^in\s+about\s+\d+\s*(?:min|mins|minute|minutes)$/i,
  /^now$/i,
  /^asap$/i,
  /^instant$/i,
  /^immediate(?:ly)?$/i,
  /^book\s+now$/i,
  /^right\s+now$/i,
];

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
};

const firstString = (...values) => {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
};

export const isInstantScheduleValue = (value) => {
  const text = asString(value);
  if (!text) return false;
  return INSTANT_MARKERS.some((pattern) => pattern.test(text));
};

const instantResult = (source = "instant") => ({
  bookingType: "instant",
  scheduleIntent: false,
  source,
  scheduledAt: null,
  slotKey: null,
  slotValue: null,
  slotLabel: null,
  slotStartAt: null,
  slotEndAt: null,
  timezone: null,
  scheduledDateLocal: null,
  scheduledTimeLocal: null,
});

const errorResult = (message, code, source = "schedule") => ({
  ...instantResult(source),
  bookingType: "schedule",
  scheduleIntent: true,
  source,
  error: message,
  errorCode: code,
});

const scheduleResult = (check, source) => ({
  bookingType: "schedule",
  scheduleIntent: true,
  source,
  scheduledAt: check.normalizedScheduledAt || check.scheduledAt,
  slotKey: check.slot?.slotKey || null,
  slotValue: check.slot?.slotValue || null,
  slotLabel: check.slot?.slotLabel || null,
  slotStartAt: check.slot?.slotStartAt || null,
  slotEndAt: check.slot?.slotEndAt || null,
  timezone: check.timezone || BUSINESS_TIMEZONE,
  scheduledDateLocal: check.scheduledDateLocal || localDateInBusinessTimezone(check.scheduledAt),
  scheduledTimeLocal:
    check.scheduledTimeLocal ||
    (() => {
      const local = formatInBusinessTimezone(check.scheduledAt);
      return `${local.hours}:${local.minutes}`;
    })(),
});

const pad2 = (value) => String(value).padStart(2, "0");

const validIsoDate = (year, month, day) => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

const allowedDayFor = (day, month, now) => {
  const days = generateScheduleDays(now, BUSINESS_TIMEZONE);
  return days.find(
    (entry) => Number(entry.date) === day && MONTHS[String(entry.month).toLowerCase()] === month
  );
};

const resolveDisplayDate = (rawValue, now) => {
  let text = asString(rawValue);
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/\btoday\b/.test(lower)) return null;
  if (/\bday\s+after\s+tomorrow\b/.test(lower) || /\bafter\s+tomorrow\b/.test(lower)) {
    return generateScheduleDays(now, BUSINESS_TIMEZONE)[1]?.fullDate || null;
  }
  if (/\btomorrow\b/.test(lower)) {
    return generateScheduleDays(now, BUSINESS_TIMEZONE)[0]?.fullDate || null;
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const ymd = text.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if (ymd) {
    return validIsoDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  }

  const dmy = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return validIsoDate(year, Number(dmy[2]), Number(dmy[1]));
  }

  const dm = text.match(/^(\d{1,2})[\/.-](\d{1,2})$/);
  if (dm) {
    const match = allowedDayFor(Number(dm[1]), Number(dm[2]), now);
    return match?.fullDate || null;
  }

  text = text.replace(
    /^(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s*,?\s+/i,
    ""
  );

  const dayMonth = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s*,?\s*(\d{4}))?$/i);
  if (dayMonth) {
    const month = MONTHS[dayMonth[2].toLowerCase()];
    if (!month) return null;
    const day = Number(dayMonth[1]);
    if (dayMonth[3]) {
      return validIsoDate(Number(dayMonth[3]), month, day);
    }
    return allowedDayFor(day, month, now)?.fullDate || null;
  }

  const monthDay = text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?$/i);
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    if (!month) return null;
    const day = Number(monthDay[2]);
    if (monthDay[3]) {
      return validIsoDate(Number(monthDay[3]), month, day);
    }
    return allowedDayFor(day, month, now)?.fullDate || null;
  }

  const weekday = lower.replace(/[^a-z]/g, "");
  const weekdayName = Object.keys(WEEKDAYS).find(
    (name) => weekday === name || (weekday.length >= 3 && name.startsWith(weekday))
  );
  if (weekdayName) {
    const short = WEEKDAYS[weekdayName];
    return generateScheduleDays(now, BUSINESS_TIMEZONE)
      .find((entry) => entry.dayName === short)?.fullDate || null;
  }

  return null;
};

const resolveTimeToHHMM = (rawValue) => {
  const text = asString(rawValue);
  if (!text) return null;

  const twelveHour = text.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (twelveHour) {
    let hours = Number(twelveHour[1]);
    const minutes = Number(twelveHour[2] || 0);
    const meridiem = twelveHour[3].toUpperCase();
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;
    return `${pad2(hours)}:${pad2(minutes)}`;
  }

  const twentyFourHour = text.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?:[^\d]|$)/);
  if (twentyFourHour) {
    const hours = Number(twentyFourHour[1]);
    const minutes = Number(twentyFourHour[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return `${pad2(hours)}:${pad2(minutes)}`;
  }

  return null;
};

const extractDateText = (rawValue) => {
  const text = asString(rawValue);
  if (!text) return "";
  return text
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b(?:\s*-\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM))?/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\b(?:at|on)\b/gi, " ")
    .replace(/[,\s]+/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "");
};

const buildFromDateAndTime = (dateValue, timeValue, now, source) => {
  const isoDate = resolveDisplayDate(dateValue, now);
  if (!isoDate) {
    return errorResult(
      `Scheduled date must be one of the next ${getScheduleDaysCount()} bookable days`,
      "INVALID_SCHEDULE",
      source
    );
  }
  const hhmm = resolveTimeToHHMM(timeValue);
  if (!hhmm) {
    return errorResult("Invalid scheduled time", "INVALID_SCHEDULE", source);
  }
  const localAt = localDateTimeToUtc(isoDate, hhmm, BUSINESS_TIMEZONE);
  if (!localAt) {
    return errorResult("Invalid scheduled date or time", "INVALID_SCHEDULE", source);
  }
  const check = validateScheduledAtUtc(localAt, { now });
  if (!check.valid) {
    return errorResult(check.error, "INVALID_SCHEDULE", source);
  }
  return scheduleResult(check, source);
};

/**
 * Resolve one cart item's effective schedule.
 * Per-item fields win; a valid top-level fallback fills items without one.
 */
export const resolveCartItemSchedule = (
  cartItem = {},
  { now = new Date(), fallbackSchedule = null } = {}
) => {
  if (cartItem.scheduledDate && cartItem.scheduledTime) {
    return normalizeScheduleRequest(cartItem, { now });
  }
  if (cartItem.scheduledAt) {
    const check = validateScheduledAtUtc(new Date(cartItem.scheduledAt), { now });
    return check.valid
      ? scheduleResult(check, "cart_item")
      : errorResult(check.error, "INVALID_SCHEDULE", "cart_item");
  }
  if (fallbackSchedule) return fallbackSchedule;
  return instantResult("cart_instant");
};

/**
 * Normalize any supported client schedule shape.
 *
 * @param {Object} body
 * @param {{ now?: Date }} [options]
 * @returns canonical schedule object; includes `scheduleIntent` and
 *          `error`/`errorCode` on invalid scheduled requests.
 */
export const normalizeScheduleRequest = (body = {}, { now = new Date() } = {}) => {
  const rawType = asString(body?.bookingType).toLowerCase();
  const instantType = ["instant", "now", "immediate"].includes(rawType);
  const scheduleType = ["schedule", "scheduled"].includes(rawType);

  const dateRaw = firstString(
    body?.scheduledDate,
    body?.bookingDate,
    body?.date,
    body?.appointmentDate
  );
  const timeRaw = firstString(
    body?.scheduledTime,
    body?.timeSlot,
    body?.slot,
    body?.appointmentTime
  );
  const scheduledAtRaw = firstString(body?.scheduledAt, body?.scheduled_at);
  const displaySlotRaw = firstString(body?.scheduledSlot, body?.slotLabel);

  if (instantType) return instantResult();
  if (
    scheduledAtRaw &&
    !dateRaw &&
    !timeRaw &&
    !displaySlotRaw &&
    isInstantScheduleValue(scheduledAtRaw)
  ) {
    return instantResult();
  }

  const displayIsInstant = isInstantScheduleValue(displaySlotRaw);
  const hasAnyScheduleInput = Boolean(
    dateRaw || timeRaw || scheduledAtRaw || (displaySlotRaw && !displayIsInstant)
  );
  const scheduleIntent = scheduleType || hasAnyScheduleInput;

  if (!scheduleIntent) return instantResult();

  let dateValue = dateRaw;
  let timeValue = timeRaw;
  let source = dateValue || timeValue ? "date_time" : "display_slot";

  if (scheduledAtRaw) {
    const isoDateOnly = scheduledAtRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateOnly) {
      if (!dateValue) dateValue = scheduledAtRaw;
      source = "scheduledAt";
    } else {
      const directDate = new Date(scheduledAtRaw);
      const looksLikeIsoDateTime =
        /^\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}/.test(scheduledAtRaw);
      if (looksLikeIsoDateTime && !Number.isNaN(directDate.getTime())) {
        const check = validateScheduledAtUtc(directDate, { now });
        if (!check.valid) {
          return errorResult(check.error, "INVALID_SCHEDULE", "scheduledAt");
        }
        return scheduleResult(check, "scheduledAt");
      }
      const displayDate = extractDateText(scheduledAtRaw);
      const displayTime = resolveTimeToHHMM(scheduledAtRaw);
      if (displayDate && displayTime) {
        if (!dateValue) dateValue = displayDate;
        if (!timeValue) timeValue = displayTime;
        source = "scheduledAt_display";
      }
    }
  }

  if (displaySlotRaw && !displayIsInstant && (!dateValue || !timeValue)) {
    const displayDate = extractDateText(displaySlotRaw);
    const displayTime = resolveTimeToHHMM(displaySlotRaw);
    if (!dateValue && displayDate) dateValue = displayDate;
    if (!timeValue && displayTime) timeValue = displayTime;
    if (!dateValue || !timeValue) source = "display_slot";
  }

  if (!dateValue || !timeValue) {
    return errorResult(
      "Select a valid date and time for this service before scheduling checkout.",
      "SCHEDULE_SELECTION_REQUIRED",
      source
    );
  }

  return buildFromDateAndTime(dateValue, timeValue, now, source);
};
