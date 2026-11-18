import multer from "multer";
import { defaultMessage, fail } from "../Utils/apiResponse.js";

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const normalizeEnvelopeBody = (body, statusCode = 200) => {
  if (!isPlainObject(body)) {
    const success = statusCode < 400;
    const normalized = {
      success,
      message: defaultMessage(statusCode, success),
      result: success ? body ?? {} : {},
    };
    if (!success && body !== undefined && body !== null) {
      normalized.details = body;
    }
    return normalized;
  }

  const normalized = { ...body };
  if (typeof normalized.success !== "boolean") {
    normalized.success = statusCode < 400;
  }

  if (typeof normalized.message !== "string" || !normalized.message.trim()) {
    if (
      normalized.message &&
      typeof normalized.message === "object" &&
      normalized.details === undefined
    ) {
      normalized.details = normalized.message;
    }
    normalized.message = defaultMessage(statusCode, normalized.success);
  }

  if (
    !Object.prototype.hasOwnProperty.call(normalized, "result") ||
    normalized.result === undefined
  ) {
    normalized.result = {};
  }

  return normalized;
};

export const apiEnvelope = (req, res, next) => {
  if (res.json?.__apiEnvelope) return next();

  const originalJson = res.json;
  const wrappedJson = function jsonWithEnvelope(body) {
    return originalJson.call(this, normalizeEnvelopeBody(body, res.statusCode));
  };
  wrappedJson.__apiEnvelope = true;
  res.json = wrappedJson;
  return next();
};

export const apiNotFound = (req, res) =>
  fail(res, 404, "Route not found", {}, {
    details: { method: req.method, path: req.originalUrl },
  });

export const apiErrorHandler = (err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);

  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    let message = err.message;
    if (err.code === "LIMIT_UNEXPECTED_FILE" && err.field) {
      message = `Unexpected field: ${err.field}`;
    } else if (err.code === "LIMIT_FILE_SIZE") {
      message = "File size too large. Max limit is 20MB.";
    }
    return fail(res, 400, message, {}, { code: err.code });
  }

  if (err?.type === "entity.parse.failed") {
    return fail(res, 400, "Invalid JSON body");
  }

  const rawStatus = Number(err?.statusCode || err?.status || 500);
  const status =
    Number.isFinite(rawStatus) && rawStatus >= 400 && rawStatus < 600
      ? rawStatus
      : 500;

  const extra = {};
  if (err?.code !== undefined && err?.code !== null) {
    extra.code = String(err.code);
  }
  if (err?.details !== undefined) extra.details = err.details;

  return fail(
    res,
    status,
    err?.message || "Internal server error",
    {},
    extra
  );
};
