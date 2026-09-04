import crypto from "node:crypto";
import https from "node:https";

/**
 * 💳 RAZORPAY CLIENT — single source of truth for Razorpay (non-X) calls.
 * Centralized so the payment controller, webhook and reconciliation crons
 * share the same transport, error handling and signature verification.
 *
 * IMPORTANT: never log key material here.
 */

const getKeys = () => {
  const keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();

  if (!keyId || !keySecret) {
    const err = new Error("Razorpay keys not configured");
    err.statusCode = 500;
    throw err;
  }

  return { keyId, keySecret };
};

export const razorpayRequest = async ({ method, path, body, headers: extraHeaders }) => {
  const { keyId, keySecret } = getKeys();
  const payload = body ? JSON.stringify(body) : "";

  const options = {
    hostname: "api.razorpay.com",
    path,
    method,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Authorization:
        "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64"),
      ...(extraHeaders || {}),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (resp) => {
      let data = "";
      resp.on("data", (c) => (data += c));
      resp.on("end", () => {
        let json = {};
        try {
          json = data ? JSON.parse(data) : {};
        } catch {
          json = { raw: data };
        }

        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          return resolve(json);
        }

        const err = new Error(
          json?.error?.description || "Razorpay request failed"
        );
        err.statusCode = resp.statusCode;
        err.details = json;
        reject(err);
      });
    });

    // ⏱ Abort hung upstream calls (10s) instead of pinning a worker until
    // the Express 60s response timeout.
    req.setTimeout(10000, () => {
      const err = new Error("Razorpay request timed out");
      err.statusCode = 504;
      req.destroy(err);
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
};

/* ================= ORDER API ================= */

export const createRazorpayOrder = async ({
  amountInPaisa,
  currency = "INR",
  receipt,
  notes = {},
}) =>
  razorpayRequest({
    method: "POST",
    path: "/v1/orders",
    body: {
      amount: amountInPaisa,
      currency,
      receipt,
      payment_capture: true,
      notes,
    },
  });

export const fetchOrderPayments = async (orderId) =>
  razorpayRequest({
    method: "GET",
    path: `/v1/orders/${orderId}/payments`,
  });

/* ================= REFUND API (idempotent) ================= */

export const createRazorpayRefund = async ({
  paymentId,
  amountInPaisa,
  speed = "normal",
  receipt,
  idempotencyKey,
}) => {
  const headers = {};
  if (idempotencyKey) headers["X-Razorpay-Idempotency"] = idempotencyKey;
  return razorpayRequest({
    method: "POST",
    path: `/v1/payments/${paymentId}/refund`,
    headers,
    body: {
      amount: amountInPaisa,
      speed,
      ...(receipt ? { receipt } : {}),
    },
  });
};

export const fetchRazorpayRefund = async (refundId) =>
  razorpayRequest({
    method: "GET",
    path: `/v1/refunds/${refundId}`,
  });

/* ================= SIGNATURE VERIFICATION ================= */

export const verifyRazorpaySignature = ({
  orderId,
  paymentId,
  signature,
}) => {
  const { keySecret } = getKeys();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  return expected === signature;
};

export const verifyWebhookSignature = (rawBody, signature) => {
  const secret = (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    const err = new Error("Razorpay webhook secret not configured");
    err.statusCode = 500;
    throw err;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody || "")
    .digest("hex");

  return expected === signature;
};
