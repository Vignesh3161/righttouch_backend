import Rating from "../Schemas/Rating.js";
import {
  createServiceRating,
  createProductRating,
  updateRating,
  deleteRating,
  rebuildRatingAggregate,
  isValidObjectId,
} from "../Services/ratingService.js";

const requireUser = (req, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    return null;
  }
  return userId;
};

/* ===============================
   CREATE RATING
   =============================== */
export const userRating = async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { bookingId, bookingType, rates, comment } = req.body;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId", result: {} });
    }
    if (!bookingId || !bookingType || rates === undefined || !comment) {
      return res.status(400).json({
        success: false,
        message: "bookingId, bookingType, rates, and comment are required",
        result: {},
      });
    }

    const { rating, aggregates } = await (bookingType === "service"
      ? createServiceRating({ userId, bookingId, rates, comment })
      : createProductRating({ userId, bookingId, rates, comment }));

    const successMessage =
      bookingType === "service"
        ? "Service rating submitted successfully"
        : "Product rating submitted successfully";

    const data = {
      ratingId: rating._id,
      bookingId: rating.bookingId,
      rates: rating.rates,
      content: rating.content,
    };

    if (bookingType === "service") {
      data.technician = aggregates.technician || null;
      data.service = aggregates.service || null;
    } else {
      data.product = aggregates.product || null;
    }

    res.status(201).json({ success: true, message: successMessage, data });
  } catch (error) {
    const status = error.statusCode || 500;
    const code = error.code;
    if (code === "duplicate") {
      return res.status(409).json({ success: false, message: error.message, result: {} });
    }
    if (code === "not_completed") {
      return res.status(400).json({ success: false, message: error.message, result: {} });
    }
    if (status !== 500) {
      return res.status(status).json({ success: false, message: error.message, result: {} });
    }
    console.error("Create rating error:", error);
    res.status(500).json({ success: false, message: "Server Error: " + error.message, result: { error: error.message } });
  }
};

/* ===============================
   GET ALL RATINGS (admin/owner filtered)
   =============================== */
export const getAllRatings = async (req, res) => {
  try {
    const { search, serviceId, technicianId, userId, bookingType, productId, rates } = req.query;

    const query = {};
    if (serviceId) query.serviceId = serviceId;
    if (technicianId) query.technicianId = technicianId;
    if (userId) query.userId = userId;
    if (productId) query.productId = productId;
    if (bookingType) query.bookingType = bookingType;
    if (rates) query.rates = Number(rates);

    if (search) {
      const searchAsNumber = Number(search);
      query.$or = [{ comment: { $regex: search, $options: "i" } }];
      if (!isNaN(searchAsNumber)) query.$or.push({ rates: searchAsNumber });
    }

    const ratings = await Rating.find(query)
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .populate("userId", "email")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "username email" },
      })
      .sort({ createdAt: -1 });

    if (!ratings || ratings.length === 0) {
      return res.status(404).json({ success: false, message: "No rating data found", result: {} });
    }

    res.status(200).json({ success: true, message: "Ratings fetched successfully", result: ratings });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", result: { error: error.message } });
  }
};

/* ===============================
   GET RATING BY ID (ownership aware)
   =============================== */
export const getRatingById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const role = (req.user?.role || "").toLowerCase();

    const rating = await Rating.findById(id)
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .populate("userId", "email")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "username email" },
      });

    if (!rating) {
      return res.status(404).json({ success: false, message: "Rating not found", result: {} });
    }

    if (role !== "admin" && role !== "owner" && rating.userId?.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Not authorized to view this rating", result: {} });
    }

    res.status(200).json({ success: true, message: "Rating fetched successfully", result: rating });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", result: { error: error.message } });
  }
};

/* ===============================
   GET MY RATINGS
   =============================== */
export const getMyRatings = async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const ratings = await Rating.find({ userId })
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, message: "My ratings fetched successfully", result: ratings });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error", result: { error: error.message } });
  }
};

/* ===============================
   UPDATE RATING
   =============================== */
export const updateRatingController = async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rates, comment } = req.body;
    const { rating, aggregates } = await updateRating(req.params.id, userId, { rates, comment });

    const data = {
      ratingId: rating._id,
      bookingId: rating.bookingId,
      rates: rating.rates,
      content: rating.content,
    };
    if (rating.bookingType === "service") {
      data.technician = aggregates.technician || null;
      data.service = aggregates.service || null;
    } else {
      data.product = aggregates.product || null;
    }

    res.status(200).json({ success: true, message: "Rating updated successfully", data });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status !== 500) {
      return res.status(status).json({ success: false, message: error.message, result: {} });
    }
    console.error("Update rating error:", error);
    res.status(500).json({ success: false, message: "Server Error", result: { error: error.message } });
  }
};

/* ===============================
   DELETE RATING
   =============================== */
export const deleteRatingController = async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rating, aggregates } = await deleteRating(req.params.id, userId);

    const data = { ratingId: rating._id, bookingId: rating.bookingId };
    if (rating.bookingType === "service") {
      data.technician = aggregates.technician || { avg: 0, count: 0 };
      data.service = aggregates.service || { avg: 0, count: 0 };
    } else {
      data.product = aggregates.product || { avg: 0, count: 0 };
    }

    res.status(200).json({ success: true, message: "Rating deleted successfully", data });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status !== 500) {
      return res.status(status).json({ success: false, message: error.message, result: {} });
    }
    console.error("Delete rating error:", error);
    res.status(500).json({ success: false, message: "Server Error", result: { error: error.message } });
  }
};

/* ===============================
   ADMIN: REBUILD AGGREGATE (reconcile)
   =============================== */
export const rebuildAggregateController = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    const result = await rebuildRatingAggregate(targetType, targetId);
    res.status(200).json({
      success: true,
      message: `${targetType} aggregate rebuilt`,
      result,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message, result: {} });
  }
};
