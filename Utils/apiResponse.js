import http from "http";

const DEFAULT_ERROR_MESSAGES = {
  400: "Invalid request",
  401: "Unauthorized",
  403: "Access denied",
  404: "Not found",
  408: "Request timeout",
  409: "Conflict",
  413: "Payload too large",
  415: "Unsupported media type",
  422: "Validation failed",
  429: "Too many requests",
  500: "Internal server error",
  502: "Bad gateway",
  503: "Service unavailable",
  504: "Gateway timeout",
};

const ALLOWED_METADATA_KEYS = [
  "code",
  "details",
  "errors",
  "fieldErrors",
  "meta",
  "pagination",
  "diagnostic",
  "total",
  "page",
  "limit",
  "totalPages",
  "totalCount",
  "hasNext",
  "hasPrevious",
];

const RESERVED_ENVELOPE_KEYS = new Set(["success", "message", "result"]);

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const defaultMessage = (statusCode, success) => {
  if (success) return http.STATUS_CODES[statusCode] || "Success";
  return (
    DEFAULT_ERROR_MESSAGES[statusCode] ||
    http.STATUS_CODES[statusCode] ||
    "Request failed"
  );
};

const normalizeMessage = (message, statusCode, success) => {
  if (typeof message === "string" && message.trim()) return message;
  return defaultMessage(statusCode, success);
};

const normalizeResult = (result) => (result === undefined ? {} : result);

const normalizeExtra = (extra) => {
  if (!isPlainObject(extra)) return {};
  const normalized = {};
  for (const key of ALLOWED_METADATA_KEYS) {
    if (extra[key] !== undefined) normalized[key] = extra[key];
  }
  return normalized;
};

const normalizeLegacyMirror = (legacy) => {
  if (!isPlainObject(legacy)) return {};
  const mirror = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (!RESERVED_ENVELOPE_KEYS.has(key) && value !== undefined) {
      mirror[key] = value;
    }
  }
  return mirror;
};

export const ok = (
  res,
  status = 200,
  message,
  result = {},
  extra = {}
) =>
  res.status(status).json({
    success: true,
    message: normalizeMessage(message, status, true),
    result: normalizeResult(result),
    ...normalizeExtra(extra),
  });

export const fail = (
  res,
  status = 500,
  message,
  result = {},
  extra = {}
) =>
  res.status(status).json({
    success: false,
    message: normalizeMessage(message, status, false),
    result: normalizeResult(result),
    ...normalizeExtra(extra),
  });

export const failFromError = (res, err, fallbackMessage = "Internal server error") => {
  const rawStatus = Number(err?.statusCode || err?.status || 500);
  const status =
    Number.isFinite(rawStatus) && rawStatus >= 400 && rawStatus < 600
      ? rawStatus
      : 500;
  const message =
    typeof err?.message === "string" && err.message.trim()
      ? err.message
      : fallbackMessage;

  const extra = {};
  if (err?.code !== undefined && err?.code !== null) {
    extra.code = String(err.code);
  }
  if (err?.details !== undefined) extra.details = err.details;
  if (err?.errors !== undefined) extra.errors = err.errors;
  if (err?.fieldErrors !== undefined) extra.fieldErrors = err.fieldErrors;

  return fail(res, status, message, err?.result ?? {}, extra);
};

// Temporary compatibility bridge. Do not use for new endpoints.
export const okLegacy = (
  res,
  status = 200,
  message,
  result = {},
  legacy = result
) =>
  res.status(status).json({
    success: true,
    message: normalizeMessage(message, status, true),
    result: normalizeResult(result),
    ...normalizeLegacyMirror(legacy),
  });

// Temporary compatibility bridge. Do not use for new endpoints.
export const failLegacy = (
  res,
  status = 500,
  message,
  result = {},
  legacy = result
) =>
  res.status(status).json({
    success: false,
    message: normalizeMessage(message, status, false),
    result: normalizeResult(result),
    ...normalizeLegacyMirror(legacy),
  });
