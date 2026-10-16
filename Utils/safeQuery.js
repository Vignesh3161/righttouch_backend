import mongoose from "mongoose";

/**
 * Shared input-safety helpers for admin/geo controllers (B-17).
 * - Malformed ObjectIds must yield 400, never a CastError 500.
 * - User-supplied literal search text must be regex-escaped.
 * - Pagination limits are capped to avoid unbounded queries.
 */

export const isValidObjectId = (id) => {
  try {
    return mongoose.Types.ObjectId.isValid(id);
  } catch {
    return false;
  }
};

/** 400 for a malformed identifier. Returns true when the response was sent. */
export const rejectBadId = (res, name = "id") => {
  res.status(400).json({ success: false, message: `Invalid ${name}`, code: "INVALID_ID" });
  return true;
};

/** Validate one id param/body field; sends 400 and returns null when malformed. */
export const requireObjectId = (res, value, name = "id") => {
  if (!value || !isValidObjectId(value)) {
    rejectBadId(res, name);
    return null;
  }
  return String(value);
};

/** Escape literal text before embedding in new RegExp (ReDoS/injection safe). */
export const escapeRegExp = (s) => String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive "contains" match on literal text. */
export const containsRegex = (s) => new RegExp(escapeRegExp(String(s ?? "").trim()), "i");

/** Case-insensitive exact match on literal text. */
export const exactRegex = (s) => new RegExp(`^${escapeRegExp(String(s ?? "").trim())}$`, "i");

/** Clamp page/limit query params to safe bounds. */
export const clampLimit = (value, def = 20, max = 100) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
};

export const clampPage = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.floor(n);
};

/** Generic 500 that never leaks driver/validation internals to clients. */
export const internalError = (res, err) => {
  if (err) console.error("[safeQuery] internal:", err.message || err);
  return res.status(500).json({ success: false, message: "Internal server error", code: "INTERNAL_ERROR" });
};
