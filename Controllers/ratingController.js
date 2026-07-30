import mongoose from "mongoose";
import Rating from "../Schemas/Rating.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import Service from "../Schemas/Service.js";
import Product from "../Schemas/Product.js";

const isValidObjectId = value => mongoose.Types.ObjectId.isValid(value);

/**
 * 📊 Reusable helper to update aggregate ratings for any entity
 * Target models can be: TechnicianProfile, Service, or Product
 */
const updateRatingAverages = async (targetId, targetType) => {
  try {
    const matchField = targetType === "TechnicianProfile" ? "technicianId" :
      targetType === "Service" ? "serviceId" : "productId";

    const stats = await Rating.aggregate([
      { $match: { [matchField]: new mongoose.Types.ObjectId(targetId) } },
      {
        $group: {
          _id: null,
          avgRating: { $avg: "$rates" },
          totalCount: { $sum: 1 },
        },
      },
    ]);

    const avg = stats.length > 0 ? Math.round(stats[0].avgRating * 10) / 10 : 0;
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

    console.log(`📊 Updated ${targetType} ${targetId} stats: ${avg} (${count} ratings)`);
  } catch (error) {
    console.error(`❌ Error updating ${targetType} ratings:`, error.message);
  }
};

/* ===============================
   CREATE RATING
   =============================== */
export const userRating = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }


    const { bookingId, bookingType, technicianId, serviceId, productId, rates, comment } = req.body;

    // ✅ Validate required fields
    if (!bookingId || !bookingType || rates === undefined || !comment) {
      return res.status(400).json({
        success: false,
        message: "bookingId, bookingType, rates, and comment are required",
        result: {},
      });
    }

    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId", result: {} });
    }

    // ✅ Validate bookingType
    if (!["product", "service"].includes(bookingType)) {
      return res.status(400).json({
        success: false,
        message: "bookingType must be 'product' or 'service'",
        result: {},
      });
    }

    // ✅ Validate rates range (1-5)
    if (rates < 1 || rates > 5 || !Number.isInteger(rates)) {
      return res.status(400).json({
        success: false,
        message: "rates must be an integer between 1 and 5",
        result: {},
      });
    }

    // ✅ Verify booking exists and belongs to user
    let booking;
    if (bookingType === "service") {
      // Use customerId (User) - matches schema
      booking = await ServiceBooking.findOne({ _id: bookingId, customerId: userId });
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: "Service booking not found or does not belong to you",
          result: {},
        });
      }
      if (booking.status !== "completed") {
        return res.status(400).json({
          success: false,
          message: "You can rate a service only after completion",
          result: {},
        });
      }

      if (serviceId && !booking.serviceId.equals(serviceId)) {
        return res.status(400).json({
          success: false,
          message: "serviceId does not match the booking",
          result: {},
        });
      }

      if (technicianId && booking.technicianId && !booking.technicianId.equals(technicianId)) {
        return res.status(400).json({
          success: false,
          message: "technicianId does not match the booking",
          result: {},
        });
      }
    } else {
      // ProductBooking uses customerId
      booking = await ProductBooking.findOne({ _id: bookingId, customerId: userId });
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: "Product booking not found or does not belong to you",
          result: {},
        });
      }
      if (booking.status !== "completed") {
        return res.status(400).json({
          success: false,
          message: "You can rate a product only after completion",
          result: {},
        });
      }

      if (productId && !booking.productId.equals(productId)) {
        return res.status(400).json({
          success: false,
          message: "productId does not match the booking",
          result: {},
        });
      }
    }

    // ✅ Check if rating already exists for this booking
    const existingRating = await Rating.findOne({ bookingId });
    if (existingRating) {
      return res.status(409).json({
        success: false,
        message: "Rating already exists for this booking",
        result: {},
      });
    }

    const ratingData = await Rating.create({
      bookingId,
      bookingType,
      technicianId: bookingType === "service" ? booking.technicianId || null : null,
      serviceId: bookingType === "service" ? booking.serviceId : null,
      productId: bookingType === "product" ? booking.productId : null,
      userId,
      rates,
      comment,
    });

    // 🔥 Multi-Rollup Update (Technician + Service or Product)
    if (bookingType === "service") {
      if (booking.technicianId) await updateRatingAverages(booking.technicianId, "TechnicianProfile");
      if (booking.serviceId) await updateRatingAverages(booking.serviceId, "Service");
    } else if (bookingType === "product") {
      if (booking.productId) await updateRatingAverages(booking.productId, "Product");
    }

    res.status(201).json({
      success: true,
      message: "Rating created successfully",
      result: ratingData,
    });
  } catch (error) {
    console.error("Create rating error:", error);
    res.status(500).json({
      success: false,
      message: "Server Error: " + error.message,
      result: { error: error.message },
    });
  }
};

/* ===============================
   GET ALL RATINGS
   =============================== */
export const getAllRatings = async (req, res) => {
  try {
    const { search, serviceId, technicianId, userId, bookingType } = req.query;

    let query = {};

    // ✅ Proper filters
    if (serviceId) query.serviceId = serviceId;
    if (technicianId) query.technicianId = technicianId;
    if (userId) query.userId = userId;
    if (bookingType) query.bookingType = bookingType;

    // ✅ Search logic
    if (search) {
      const searchAsNumber = Number(search);
      query.$or = [{ comment: { $regex: search, $options: "i" } }];

      if (!isNaN(searchAsNumber)) {
        query.$or.push({ rates: searchAsNumber });
      }
    }

    const ratings = await Rating.find(query)
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .populate("userId", "email")
      .populate({
        path: "technicianId",
        populate: {
          path: "userId",
          select: "username email",
        },
      });

    if (!ratings || ratings.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No rating data found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Ratings fetched successfully",
      result: ratings,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: { error: error.message },
    });
  }
};

/* ===============================
   GET RATING BY ID
   =============================== */
export const getRatingById = async (req, res) => {
  try {
    const { id } = req.params;

    const rating = await Rating.findById(id)
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .populate("userId", "email")
      .populate({
        path: "technicianId",
        populate: {
          path: "userId",
          select: "username email",
        },
      });

    if (!rating)
      return res
        .status(404)
        .json({ success: false, message: "Rating not found", result: {} });

    res.status(200).json({
      success: true,
      message: "Rating fetched successfully",
      result: rating,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: { error: error.message },
    });
  }
};

/* ===============================
   GET MY RATINGS
   =============================== */
export const getMyRatings = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const ratings = await Rating.find({ userId })
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      message: "My ratings fetched successfully",
      result: ratings,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: { error: error.message },
    });
  }
};

/* ===============================
   UPDATE RATING
   =============================== */
export const updateRating = async (req, res) => {
  try {
    const { id } = req.params;

    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const allowed = {};
    if (req.body.hasOwnProperty("rates")) {
      const newRate = req.body.rates;
      if (!Number.isInteger(newRate) || newRate < 1 || newRate > 5) {
        return res.status(400).json({ success: false, message: "rates must be an integer between 1 and 5", result: {} });
      }
      allowed.rates = newRate;
    }
    if (req.body.hasOwnProperty("comment")) {
      allowed.comment = req.body.comment;
    }

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update", result: {} });
    }

    const rating = await Rating.findOneAndUpdate(
      { _id: id, userId: userId },
      allowed,
      { new: true, runValidators: true }
    );

    if (!rating) {
      return res.status(404).json({
        success: false,
        message: "Rating not found or not yours",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Rating updated successfully",
      result: rating,
    });

    // 🔥 Re-calculate stats after update
    if (rating.bookingType === "service") {
      if (rating.technicianId) await updateRatingAverages(rating.technicianId, "TechnicianProfile");
      if (rating.serviceId) await updateRatingAverages(rating.serviceId, "Service");
    } else if (rating.bookingType === "product") {
      if (rating.productId) await updateRatingAverages(rating.productId, "Product");
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: { error: error.message },
    });
  }
};

/* ===============================
   DELETE RATING
   =============================== */
export const deleteRating = async (req, res) => {
  try {
    const { id } = req.params;

    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const rating = await Rating.findOneAndDelete({ _id: id, userId: userId });

    if (!rating) {
      return res.status(404).json({
        success: false,
        message: "Rating not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Rating deleted successfully",
      result: {},
    });

    // 🔥 Re-calculate stats after deletion
    if (rating.bookingType === "service") {
      if (rating.technicianId) await updateRatingAverages(rating.technicianId, "TechnicianProfile");
      if (rating.serviceId) await updateRatingAverages(rating.serviceId, "Service");
    } else if (rating.bookingType === "product") {
      if (rating.productId) await updateRatingAverages(rating.productId, "Product");
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: { error: error.message },
    });
  }
};
