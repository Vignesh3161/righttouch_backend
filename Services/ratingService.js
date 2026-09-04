import mongoose from "mongoose";
import Rating from "../Schemas/Rating.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import Service from "../Schemas/Service.js";
import Product from "../Schemas/Product.js";

/* ===============================
   CONTENT LABEL (display only)
   5,4 → Excellent · 3 → Good
   2 → Average · 1 → Below Average
   Never affects numerical calculation.
   =============================== */
export const contentForRate = (rates) => {
  if (rates >= 4) return "Excellent";
  if (rates >= 3) return "Good";
  if (rates >= 2) return "Average";
  return "Below Average";
};

/* ===============================
   VALIDATION HELPERS
   =============================== */
export const isValidObjectId = (value) =>
  typeof value === "string" && mongoose.Types.ObjectId.isValid(value);

export const isValidRate = (rates) =>
  Number.isInteger(rates) && rates >= 1 && rates <= 5;

/* ===============================
   STRUCTURED LOGGING + METRICS
   Lightweight observables (no external dep).
   =============================== */
const logRating = (level, operation, meta = {}) => {
  const entry = {
    ts: new Date().toISOString(),
    layer: "rating",
    level,
    operation,
    ...meta,
  };
  if (level === "error") console.error("📊 rating:", entry);
  else console.log("📊 rating:", entry);
};

// Observability metric names (architecture §54).
const METRICS = {
  createdService: "rating.created.service",
  createdProduct: "rating.created.product",
  updatedService: "rating.updated.service",
  updatedProduct: "rating.updated.product",
  deletedService: "rating.deleted.service",
  deletedProduct: "rating.deleted.product",
  aggregateFailure: "rating.aggregate.failure",
  duplicate: "rating.duplicate",
  unauthorized: "rating.unauthorized",
  notCompleted: "rating.not_completed",
};

const emitMetric = (name, meta = {}) => logRating("info", name, meta);

/* ===============================
   AGGREGATE ROLLUP
   bookingType is ALWAYS filtered so a product rating can never
   leak into a technician/service aggregate and vice-versa.
   =============================== */
const TARGET_MAP = {
  TechnicianProfile: { field: "technicianId", bookingType: "service" },
  Service: { field: "serviceId", bookingType: "service" },
  Product: { field: "productId", bookingType: "product" },
};

export const updateRatingAverages = async (targetId, targetType) => {
  const mapping = TARGET_MAP[targetType];
  if (!mapping) {
    logRating("error", "aggregate.unknown_target", { targetType });
    return { avg: 0, count: 0 };
  }

  const { field, bookingType } = mapping;
  const targetObjId = new mongoose.Types.ObjectId(targetId);

  try {
    const stats = await Rating.aggregate([
      {
        $match: {
          [field]: targetObjId,
          bookingType,
        },
      },
      {
        $group: {
          _id: null,
          avgRating: { $avg: "$rates" },
          totalCount: { $sum: 1 },
        },
      },
    ]);

    const avg =
      stats.length > 0 ? Math.round(stats[0].avgRating * 10) / 10 : 0;
    const count = stats.length > 0 ? stats[0].totalCount : 0;

    if (targetType === "TechnicianProfile") {
      await TechnicianProfile.findByIdAndUpdate(targetId, {
        "rating.avg": avg,
        "rating.count": count,
      });
    } else if (targetType === "Service") {
      await Service.findByIdAndUpdate(targetId, {
        "ratingSummary.averageRating": avg,
        "ratingSummary.totalRatings": count,
      });
    } else if (targetType === "Product") {
      await Product.findByIdAndUpdate(targetId, {
        "ratingSummary.averageRating": avg,
        "ratingSummary.totalRatings": count,
      });
    }

    logRating("info", `aggregate.updated.${bookingType}`, {
      targetType,
      targetId,
      avg,
      count,
    });

    return { avg, count };
  } catch (error) {
    // Do NOT silently swallow — surface with full context for retry/reconcile.
    logRating("error", "aggregate.failure", {
      targetType,
      targetId,
      error: error.message,
    });
    emitMetric(METRICS.aggregateFailure, { targetType, targetId, error: error.message });
    throw error;
  }
};

/* ===============================
   RECONCILIATION / REBUILD
   Recompute averages for a target from scratch.
   =============================== */
export const rebuildRatingAggregate = async (targetType, targetId) => {
  if (!TARGET_MAP[targetType]) {
    throw new Error(`Unknown rating target type: ${targetType}`);
  }
  if (!isValidObjectId(targetId)) {
    throw new Error("Invalid targetId");
  }
  const result = await updateRatingAverages(targetId, targetType);
  logRating("info", "aggregate.rebuilt", {
    targetType,
    targetId,
    avg: result.avg,
    count: result.count,
  });
  return result;
};

/* ===============================
   LOAD + VALIDATE BOOKING
   The booking is the single source of truth for ownership,
   completion status and the target ids (technician/service/product).
   =============================== */
const loadBooking = async (bookingId, bookingType, userId) => {
  if (bookingType === "service") {
    const booking = await ServiceBooking.findOne({
      _id: bookingId,
      customerId: userId,
    });
    return booking;
  }
  const booking = await ProductBooking.findOne({
    _id: bookingId,
    customerId: userId,
  });
  return booking;
};

/* ===============================
   CREATE RATING
   One Rating per completed booking.
   Service → feeds Technician + Service aggregates.
   Product → feeds Product aggregate only.
   =============================== */
export const createRating = async ({ userId, bookingId, bookingType, rates, comment }) => {
  // 1. Validate rate
  if (!isValidRate(rates)) {
    const err = new Error("rates must be an integer between 1 and 5");
    err.statusCode = 400;
    throw err;
  }

  // 2. Validate bookingType
  if (!["product", "service"].includes(bookingType)) {
    const err = new Error("bookingType must be 'product' or 'service'");
    err.statusCode = 400;
    throw err;
  }

  // 3. Load + verify ownership
  const booking = await loadBooking(bookingId, bookingType, userId);
  if (!booking) {
    const err = new Error(
      bookingType === "service"
        ? "Service booking not found or does not belong to you"
        : "Product booking not found or does not belong to you"
    );
    err.statusCode = 404;
    throw err;
  }

    // 4. Verify completion (status === "completed", NOT paymentStatus)
  if (booking.status !== "completed") {
    const err = new Error(
      bookingType === "service"
        ? "You can rate a service only after completion"
        : "You can rate a product only after completion"
    );
    err.statusCode = 400;
    err.code = "not_completed";
    emitMetric(METRICS.notCompleted, { bookingId, bookingType, customerId: userId });
    throw err;
  }

  // 5. One rating per booking — idempotency
  const existing = await Rating.findOne({ bookingId });
  if (existing) {
    const err = new Error("Rating already exists for this booking");
    err.statusCode = 409;
    err.code = "duplicate";
    emitMetric(METRICS.duplicate, { bookingId, bookingType, customerId: userId });
    throw err;
  }

  // 6. Derive target ids strictly from the booking (never trust client)
  const ratingData = {
    bookingId,
    bookingType,
    userId,
    rates,
    comment,
    technicianId:
      bookingType === "service" ? booking.technicianId || null : null,
    serviceId: bookingType === "service" ? booking.serviceId : null,
    productId: bookingType === "product" ? booking.productId : null,
  };

  const rating = await Rating.create(ratingData);
  logRating("info", `rating.created.${bookingType}`, {
    ratingId: rating._id.toString(),
    bookingId,
    bookingType,
    customerId: userId,
    targetId:
      bookingType === "service"
        ? rating.technicianId || rating.serviceId
        : rating.productId,
    targetType: bookingType === "service" ? "TechnicianProfile/Service" : "Product",
    rates,
    operation: "create",
  });
  emitMetric(
    bookingType === "service" ? METRICS.createdService : METRICS.createdProduct,
    { ratingId: rating._id.toString(), bookingId, bookingType, customerId: userId, rates }
  );

  // 7. Rollup aggregates
  const aggregates = await rollupForRating(rating);

  return { rating, aggregates };
};

/* ===============================
   ROLLUP DISPATCH for a Rating doc
   =============================== */
export const rollupForRating = async (rating) => {
  const out = {};
  if (rating.bookingType === "service") {
    if (rating.technicianId) {
      out.technician = await updateRatingAverages(
        rating.technicianId,
        "TechnicianProfile"
      );
    }
    if (rating.serviceId) {
      out.service = await updateRatingAverages(rating.serviceId, "Service");
    }
  } else if (rating.bookingType === "product") {
    if (rating.productId) {
      out.product = await updateRatingAverages(rating.productId, "Product");
    }
  }
  return out;
};

/* ===============================
   UPDATE RATING
   =============================== */
export const updateRating = async (id, userId, { rates, comment }) => {
  const allowed = {};
  if (rates !== undefined) {
    if (!isValidRate(rates)) {
      const err = new Error("rates must be an integer between 1 and 5");
      err.statusCode = 400;
      throw err;
    }
    allowed.rates = rates;
  }
  if (comment !== undefined) allowed.comment = comment;

  if (Object.keys(allowed).length === 0) {
    const err = new Error("Nothing to update");
    err.statusCode = 400;
    throw err;
  }

  const rating = await Rating.findOneAndUpdate(
    { _id: id, userId },
    allowed,
    { new: true, runValidators: true }
  );

  if (!rating) {
    const err = new Error("Rating not found or not yours");
    err.statusCode = 404;
    throw err;
  }

  logRating("info", `rating.updated.${rating.bookingType}`, {
    ratingId: rating._id.toString(),
    bookingId: rating.bookingId?.toString(),
    customerId: userId,
    rates: rating.rates,
  });
  emitMetric(
    rating.bookingType === "service" ? METRICS.updatedService : METRICS.updatedProduct,
    { ratingId: rating._id.toString(), bookingId: rating.bookingId?.toString(), customerId: userId, rates: rating.rates }
  );

  const aggregates = await rollupForRating(rating);
  return { rating, aggregates };
};

/* ===============================
   DELETE RATING
   =============================== */
export const deleteRating = async (id, userId) => {
  const rating = await Rating.findOneAndDelete({ _id: id, userId });
  if (!rating) {
    const err = new Error("Rating not found or not yours");
    err.statusCode = 404;
    throw err;
  }

  logRating("info", `rating.deleted.${rating.bookingType}`, {
    ratingId: rating._id.toString(),
    bookingId: rating.bookingId?.toString(),
    customerId: userId,
  });
  emitMetric(
    rating.bookingType === "service" ? METRICS.deletedService : METRICS.deletedProduct,
    { ratingId: rating._id.toString(), bookingId: rating.bookingId?.toString(), customerId: userId }
  );

  const aggregates = await rollupForRating(rating);
  return { rating, aggregates };
};

/* ===============================
   TYPED WRAPPERS (architecture §18/§19)
   The controller dispatches by bookingType, but the single createRating()
   core already handles both domains. These wrappers enforce the bookingType
   so call-sites are explicit and future-proof.
   =============================== */
export const createServiceRating = ({ userId, bookingId, rates, comment }) =>
  createRating({ userId, bookingId, bookingType: "service", rates, comment });

export const createProductRating = ({ userId, bookingId, rates, comment }) =>
  createRating({ userId, bookingId, bookingType: "product", rates, comment });
