import PaymentAttempt from "../Schemas/PaymentAttempt.js";

export const ATTEMPT_TTL_MS = parseInt(process.env.PAYMENT_ATTEMPT_TTL_MS, 10) || 15 * 60 * 1000;

/**
 * Record a payment attempt (one per Razorpay order / cash declaration).
 * Idempotent per (paymentId, idempotencyKey): a replay with the same key
 * returns the original attempt instead of creating a duplicate order.
 */
export const createAttempt = async ({
  paymentId,
  bookingId,
  customerId,
  amountPaise,
  method = "razorpay",
  idempotencyKey,
  providerOrderId = null,
  state = "created",
}) => {
  const expiresAt = new Date(Date.now() + ATTEMPT_TTL_MS);

  if (idempotencyKey) {
    const existing = await PaymentAttempt.findOne({ paymentId, idempotencyKey }).lean();
    if (existing) return existing;
  }

  const attempt = new PaymentAttempt({
    paymentId: paymentId || undefined,
    bookingId,
    customerId,
    method,
    amountPaise,
    idempotencyKey,
    providerOrderId,
    state,
    expiresAt,
  });
  await attempt.save();
  return attempt;
};

/** Close an attempt (captured / failed / expired). Idempotent. */
export const closeAttempt = async (attemptId, { state, providerPaymentId, failureCode, failureReason, failureSource }) => {
  const update = { state, closedAt: new Date() };
  if (providerPaymentId) update.providerPaymentId = providerPaymentId;
  if (failureCode) update.failureCode = failureCode;
  if (failureReason) update.failureReason = failureReason;
  if (failureSource) update.failureSource = failureSource;
  return PaymentAttempt.findByIdAndUpdate(attemptId, update, { new: true });
};

/** True if a non-expired live attempt exists (blocks unsafe retry). */
export const hasLiveAttempt = async (paymentId) => {
  if (!paymentId) return false;
  const count = await PaymentAttempt.countDocuments({
    paymentId,
    state: { $in: ["created", "authorized"] },
    expiresAt: { $gt: new Date() },
  });
  return count > 0;
};

/** Sweeper: mark stale created attempts as expired so retry is unblocked. */
export const expireStaleAttempts = async () => {
  const res = await PaymentAttempt.updateMany(
    { state: "created", expiresAt: { $lt: new Date() } },
    { $set: { state: "expired", closedAt: new Date() } }
  );
  return res.modifiedCount || 0;
};
