import mongoose from "mongoose";
import GlobalSetting from "../Schemas/GlobalSetting.js";

export const SLOT_CONFIG_KEY = "schedule.slots";

export const DEFAULT_SLOT_CONFIG = Object.freeze({
  scheduleDays: 5,
  windowStartHour: 9,
  windowEndHour: 21,
  slotCount: 4,
});

const LIMITS = {
  scheduleDays: { min: 1, max: 30 },
  windowStartHour: { min: 0, max: 22 },
  windowEndHour: { min: 1, max: 23 },
  slotCount: { min: 1, max: 12 },
  minSlotMinutes: 30,
};

let cachedConfig = { ...DEFAULT_SLOT_CONFIG };
let cachedVersion = 0;
let cachedUpdatedAt = null;
let cachedUpdatedBy = null;
let cachedUpdatedByRole = null;
let lastLoadedAt = 0;
let loadPromise = null;

const canUseDb = () => mongoose.connection?.readyState === 1;

const toInteger = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : NaN;
};

export const validateSlotConfig = (input = {}, base = DEFAULT_SLOT_CONFIG) => {
  const merged = {
    scheduleDays: input.scheduleDays ?? base.scheduleDays,
    windowStartHour: input.windowStartHour ?? base.windowStartHour,
    windowEndHour: input.windowEndHour ?? base.windowEndHour,
    slotCount: input.slotCount ?? base.slotCount,
  };

  const config = {
    scheduleDays: toInteger(merged.scheduleDays),
    windowStartHour: toInteger(merged.windowStartHour),
    windowEndHour: toInteger(merged.windowEndHour),
    slotCount: toInteger(merged.slotCount),
  };

  const errors = [];
  for (const [field, value] of Object.entries(config)) {
    if (!Number.isInteger(value)) {
      errors.push(`${field} must be an integer`);
      continue;
    }
    const limit = LIMITS[field];
    if (value < limit.min || value > limit.max) {
      errors.push(`${field} must be between ${limit.min} and ${limit.max}`);
    }
  }

  if (Number.isInteger(config.windowStartHour) && Number.isInteger(config.windowEndHour)) {
    if (config.windowEndHour <= config.windowStartHour) {
      errors.push("windowEndHour must be greater than windowStartHour");
    } else {
      const totalMinutes = (config.windowEndHour - config.windowStartHour) * 60;
      if (Number.isInteger(config.slotCount) && config.slotCount > 0) {
        if (totalMinutes % config.slotCount !== 0) {
          errors.push("The window must divide evenly into slotCount slots");
        } else if (totalMinutes / config.slotCount < LIMITS.minSlotMinutes) {
          errors.push(`Each slot must be at least ${LIMITS.minSlotMinutes} minutes`);
        }
      }
    }
  }

  if (errors.length) return { valid: false, config: null, errors };
  return { valid: true, config, errors: [] };
};

const applySettingDoc = (doc) => {
  const validation = validateSlotConfig(doc?.value || {}, DEFAULT_SLOT_CONFIG);
  cachedConfig = validation.valid ? validation.config : { ...DEFAULT_SLOT_CONFIG };
  cachedVersion += 1;
  cachedUpdatedAt = doc?.lastUpdatedAt || doc?.updatedAt || null;
  cachedUpdatedBy = doc?.updatedBy || null;
  cachedUpdatedByRole = doc?.updatedByRole || null;
};

export const getSlotConfig = () => ({ ...cachedConfig });

export const getSlotConfigVersion = () => cachedVersion;

export const getSlotConfigState = () => ({
  config: getSlotConfig(),
  version: cachedVersion,
  updatedAt: cachedUpdatedAt,
  updatedBy: cachedUpdatedBy,
  updatedByRole: cachedUpdatedByRole,
  loadedAt: lastLoadedAt ? new Date(lastLoadedAt) : null,
});

export const loadSlotConfig = async ({ force = false } = {}) => {
  if (!canUseDb()) return getSlotConfigState();
  if (!force && loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const doc = await GlobalSetting.findOne({ key: SLOT_CONFIG_KEY }).lean();
      if (doc) applySettingDoc(doc);
      lastLoadedAt = Date.now();
    } catch (error) {
      console.error("loadSlotConfig Error:", error.message);
    } finally {
      loadPromise = null;
    }
    return getSlotConfigState();
  })();

  return loadPromise;
};

export const initSlotConfig = () => loadSlotConfig({ force: true });

export const refreshSlotConfigIfStale = async (ttlMs = 60000) => {
  if (!canUseDb()) return getSlotConfigState();
  if (!lastLoadedAt || Date.now() - lastLoadedAt >= ttlMs) {
    return loadSlotConfig({ force: true });
  }
  return getSlotConfigState();
};

export const saveSlotConfig = async (input = {}, actor = null) => {
  const validation = validateSlotConfig(input, getSlotConfig());
  if (!validation.valid) {
    const error = new Error(validation.errors.join("; "));
    error.statusCode = 400;
    error.code = "INVALID_SLOT_CONFIG";
    error.details = { errors: validation.errors };
    throw error;
  }

  if (!canUseDb()) {
    const error = new Error("Database is not connected");
    error.statusCode = 503;
    throw error;
  }

  const doc = await GlobalSetting.findOneAndUpdate(
    { key: SLOT_CONFIG_KEY },
    {
      $set: {
        value: validation.config,
        updatedBy: actor?.userId || null,
        updatedByRole: actor?.role || null,
        lastUpdatedAt: new Date(),
      },
    },
    { new: true, upsert: true }
  ).lean();

  applySettingDoc(doc);
  lastLoadedAt = Date.now();
  return getSlotConfigState();
};

export const resetSlotConfig = async (actor = null) =>
  saveSlotConfig({ ...DEFAULT_SLOT_CONFIG }, actor);
