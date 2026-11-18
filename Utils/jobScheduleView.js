import {
  BUSINESS_TIMEZONE,
  formatInBusinessTimezone,
  generateTimeSlots,
  getSlotForTime,
  localDateInBusinessTimezone,
  localDateTimeToUtc,
} from "./slots.js";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const validLocalDate = (value, tz) => {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return localDateTimeToUtc(text, "00:00", tz) ? text : null;
};

export const addDaysToLocalDate = (localDate, days, tz = BUSINESS_TIMEZONE) => {
  const anchor = localDateTimeToUtc(localDate, "12:00", tz);
  if (!anchor) return null;
  return localDateInBusinessTimezone(new Date(anchor.getTime() + days * DAY_MS), tz);
};

const daysBetween = (start, end, tz) => {
  const startAt = localDateTimeToUtc(start, "00:00", tz);
  const endAt = localDateTimeToUtc(end, "00:00", tz);
  if (!startAt || !endAt) return NaN;
  return Math.round((endAt.getTime() - startAt.getTime()) / DAY_MS);
};

export const resolveCalendarRange = ({
  date = null,
  fromDate = null,
  toDate = null,
  now = new Date(),
  defaultDays = 6,
  maxDays = 31,
  tz = BUSINESS_TIMEZONE,
} = {}) => {
  const today = localDateInBusinessTimezone(now, tz);
  let start;
  let end;

  if (date) {
    start = validLocalDate(date, tz);
    if (!start) return { error: "date must be a valid YYYY-MM-DD value" };
    end = start;
  } else {
    start = fromDate ? validLocalDate(fromDate, tz) : today;
    if (!start) return { error: "fromDate must be a valid YYYY-MM-DD value" };
    if (toDate) {
      end = validLocalDate(toDate, tz);
      if (!end) return { error: "toDate must be a valid YYYY-MM-DD value" };
    } else {
      end = addDaysToLocalDate(start, Math.max(0, defaultDays - 1), tz);
    }
  }

  if (start > end) return { error: "fromDate must be on or before toDate" };

  const dayCount = daysBetween(start, end, tz) + 1;
  if (!Number.isFinite(dayCount) || dayCount < 1) {
    return { error: "Invalid date range" };
  }
  if (dayCount > maxDays) {
    return { error: `Date range cannot exceed ${maxDays} days` };
  }

  const from = localDateTimeToUtc(start, "00:00", tz);
  const endOfDay = localDateTimeToUtc(end, "23:59", tz);
  if (!from || !endOfDay) return { error: "Invalid date range" };

  return {
    fromDate: start,
    toDate: end,
    from,
    to: new Date(endOfDay.getTime() + MINUTE_MS - 1),
    dayCount,
    dayValues: Array.from({ length: dayCount }, (_, index) => addDaysToLocalDate(start, index, tz)),
  };
};

const dayLabel = (localDate, now, tz) => {
  const today = localDateInBusinessTimezone(now, tz);
  if (localDate === today) return "Today";
  if (localDate === addDaysToLocalDate(today, 1, tz)) return "Tomorrow";
  if (localDate === addDaysToLocalDate(today, 2, tz)) return "Day after Tomorrow";
  const noon = localDateTimeToUtc(localDate, "12:00", tz);
  if (!noon) return "";
  return formatInBusinessTimezone(noon, tz).weekday;
};

const dayMetadata = (localDate, now, tz) => {
  const noon = localDateTimeToUtc(localDate, "12:00", tz);
  const parts = noon ? formatInBusinessTimezone(noon, tz) : { day: localDate.slice(8), month: localDate.slice(5, 7), weekday: "" };
  return {
    date: Number(parts.day),
    month: MONTH_NAMES[Number(parts.month) - 1] || "",
    fullDate: localDate,
    weekday: parts.weekday,
    label: dayLabel(localDate, now, tz),
  };
};

const timeLabel = (value) => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return String(value || "");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(displayHour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${suffix}`;
};

const formatTime24 = (date, tz) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
};

const fallbackSlotDefinition = (job, tz = BUSINESS_TIMEZONE) => {
  const value = job.slotValue || job.scheduledTimeLocal || null;
  if (!value) return null;
  const timeMatch = /^(\d{2}):(\d{2})/.exec(String(value));
  const startTime = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : "00:00";
  const endAt = job.slotEndAt ? new Date(job.slotEndAt) : null;
  const endTime = endAt && Number.isFinite(endAt.getTime())
    ? formatTime24(endAt, tz)
    : startTime;
  return {
    value,
    label: job.slotLabel || (timeMatch ? `${timeLabel(startTime)} - ${timeLabel(endTime)}` : "Unscheduled"),
    startTime,
    endTime,
  };
};

export const buildScheduledJobCalendar = ({
  jobs = [],
  fromDate,
  toDate,
  now = new Date(),
  tz = BUSINESS_TIMEZONE,
  includeEmptySlots = true,
} = {}) => {
  const configuredSlots = generateTimeSlots().map(({ value, label, startTime, endTime }) => ({
    value,
    label,
    startTime,
    endTime,
  }));
  const knownSlots = new Map(configuredSlots.map((slot) => [slot.value, slot]));
  const grouped = new Map();
  let totalJobs = 0;

  for (const job of jobs) {
    const scheduledAt = new Date(job.scheduledAt);
    const slot = Number.isFinite(scheduledAt.getTime()) ? getSlotForTime(scheduledAt, tz) : null;
    const localDate = job.scheduledDateLocal || slot?.localDate || (Number.isFinite(scheduledAt.getTime()) ? localDateInBusinessTimezone(scheduledAt, tz) : null);
    if (!localDate || localDate < fromDate || localDate > toDate) continue;

    const slotValue = job.slotValue || slot?.slotValue || job.scheduledTimeLocal || "unscheduled";
    const definition = knownSlots.get(slotValue) || fallbackSlotDefinition({ ...job, slotValue }, tz);
    if (!definition) continue;
    if (!knownSlots.has(slotValue)) knownSlots.set(slotValue, definition);

    if (!grouped.has(localDate)) grouped.set(localDate, new Map());
    const bySlot = grouped.get(localDate);
    if (!bySlot.has(slotValue)) bySlot.set(slotValue, []);
    bySlot.get(slotValue).push(job);
    totalJobs += 1;
  }

  const allSlots = Array.from(knownSlots.values()).sort((a, b) =>
    String(a.startTime).localeCompare(String(b.startTime))
  );

  const days = [];
  const dayCount = daysBetween(fromDate, toDate, tz) + 1;

  for (let index = 0; index < dayCount; index++) {
    const localDate = addDaysToLocalDate(fromDate, index, tz);
    const bySlot = grouped.get(localDate) || new Map();
    const slotValues = includeEmptySlots
      ? allSlots.map((slot) => slot.value)
      : Array.from(bySlot.keys()).sort();

    const slots = slotValues
      .map((value) => {
        const definition = knownSlots.get(value) || fallbackSlotDefinition({ slotValue: value }, tz);
        const slotJobs = bySlot.get(value) || [];
        return {
          value,
          label: definition?.label || value,
          startTime: definition?.startTime || value,
          endTime: definition?.endTime || value,
          jobCount: slotJobs.length,
          jobs: slotJobs,
        };
      })
      .filter(Boolean);

    const jobCount = slots.reduce((sum, slot) => sum + slot.jobCount, 0);
    days.push({
      ...dayMetadata(localDate, now, tz),
      jobCount,
      slots,
    });
  }

  return {
    timezone: tz,
    fromDate,
    toDate,
    totalJobs,
    days,
  };
};
