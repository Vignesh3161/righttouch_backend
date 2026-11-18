import test from "node:test";
import assert from "node:assert/strict";
import multer from "multer";
import {
  ok,
  fail,
  failFromError,
  okLegacy,
  failLegacy,
} from "../Utils/apiResponse.js";
import {
  apiEnvelope,
  apiNotFound,
  apiErrorHandler,
  normalizeEnvelopeBody,
} from "../Middleware/apiEnvelope.js";
import { checkApiResponses } from "../scripts/checkApiResponses.mjs";

const makeRes = () => {
  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    sentBody: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.sentBody = body;
      return this;
    },
  };
  return res;
};

const quietErrorHandler = (err, req, res, next) => {
  const originalError = console.error;
  console.error = () => {};
  try {
    return apiErrorHandler(err, req, res, next);
  } finally {
    console.error = originalError;
  }
};

test("ok returns the canonical success envelope", () => {
  const res = makeRes();
  ok(res, 201, "Created", { id: "1" }, { code: "CREATED" });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, {
    success: true,
    message: "Created",
    result: { id: "1" },
    code: "CREATED",
  });
});

test("fail defaults result to an empty object", () => {
  const res = makeRes();
  fail(res, 404, "Missing");
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    success: false,
    message: "Missing",
    result: {},
  });
});

test("failFromError maps status, code, and details", () => {
  const res = makeRes();
  const error = new Error("Invalid");
  error.statusCode = 422;
  error.code = "INVALID_INPUT";
  error.details = { field: "name" };
  failFromError(res, error);
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    success: false,
    message: "Invalid",
    result: {},
    code: "INVALID_INPUT",
    details: { field: "name" },
  });
});

test("envelope normalization fills missing fields and sanitizes messages", () => {
  assert.deepEqual(normalizeEnvelopeBody({ status: "ok" }, 200), {
    success: true,
    message: "OK",
    result: {},
    status: "ok",
  });

  const normalized = normalizeEnvelopeBody(
    { success: false, message: { reason: "missing" } },
    400
  );
  assert.equal(normalized.message, "Invalid request");
  assert.deepEqual(normalized.details, { reason: "missing" });
  assert.deepEqual(normalized.result, {});
});

test("apiEnvelope normalizes raw res.json responses and keeps status codes", () => {
  const res = makeRes();
  apiEnvelope({}, res, () => {});
  res.status(200).json({ status: "ok" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, "OK");
  assert.deepEqual(res.body.result, {});
  assert.equal(res.body.status, "ok");
});

test("apiEnvelope does not touch non-JSON send responses", () => {
  const res = makeRes();
  apiEnvelope({}, res, () => {});
  res.status(204).send();
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, undefined);
});

test("legacy mirror helpers keep result plus top-level aliases", () => {
  const res = makeRes();
  okLegacy(
    res,
    200,
    "Wallet",
    { available: 100 },
    { available: 100, legacyFlag: true }
  );
  assert.deepEqual(res.body, {
    success: true,
    message: "Wallet",
    result: { available: 100 },
    available: 100,
    legacyFlag: true,
  });

  const errorRes = makeRes();
  failLegacy(
    errorRes,
    409,
    "Conflict",
    { reason: "expired" },
    { reason: "expired" }
  );
  assert.deepEqual(errorRes.body, {
    success: false,
    message: "Conflict",
    result: { reason: "expired" },
    reason: "expired",
  });
});

test("apiNotFound returns a JSON 404 envelope", () => {
  const res = makeRes();
  apiNotFound(
    { method: "GET", originalUrl: "/missing" },
    res
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, "Route not found");
  assert.deepEqual(res.body.result, {});
  assert.deepEqual(res.body.details, {
    method: "GET",
    path: "/missing",
  });
});

test("apiErrorHandler handles body parser and generic errors", () => {
  const parseRes = makeRes();
  quietErrorHandler(
    { type: "entity.parse.failed", message: "bad json" },
    {},
    parseRes,
    () => {}
  );
  assert.equal(parseRes.statusCode, 400);
  assert.equal(parseRes.body.success, false);
  assert.deepEqual(parseRes.body.result, {});

  const genericRes = makeRes();
  const error = new Error("Boom");
  error.statusCode = 500;
  quietErrorHandler(error, {}, genericRes, () => {});
  assert.equal(genericRes.statusCode, 500);
  assert.equal(genericRes.body.message, "Boom");
  assert.deepEqual(genericRes.body.result, {});
});

test("apiErrorHandler handles Multer errors", () => {
  const res = makeRes();
  const error = new multer.MulterError("LIMIT_FILE_SIZE");
  quietErrorHandler(error, {}, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, "LIMIT_FILE_SIZE");
  assert.deepEqual(res.body.result, {});
});

test("all backend JSON responses satisfy the response contract", () => {
  const violations = checkApiResponses({ rootDir: process.cwd() });
  assert.equal(
    violations.length,
    0,
    violations
      .map((item) => `${item.file}:${item.line} ${item.message}`)
      .join("\n")
  );
});
