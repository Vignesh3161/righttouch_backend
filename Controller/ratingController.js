import Rating from "../Schemas/Rating.js";

/* ===============================
   CREATE RATING
   =============================== */
export const userRating = async (req, res) => {
  try {
    const { technicianId, serviceId, customerId, rates, comment } = req.body;

    // ✅ Correct validation (rates can be 0)
    if (!serviceId || !customerId || rates === undefined || !comment) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        result: "Missing required fields",
      });
    }

    const ratingData = await Rating.create({
      technicianId, // optional
      serviceId,
      customerId,
      rates,
      comment,
    });

    res.status(201).json({
      success: true,
      message: "Rating created successfully",
      result: ratingData,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message,
    });
  }
};

/* ===============================
   GET ALL RATINGS
   =============================== */
export const getAllRatings = async (req, res) => {
  try {
    const { search, serviceId, technicianId, customerId } = req.query;

    let query = {};

    // ✅ Proper filters
    if (serviceId) query.serviceId = serviceId;
    if (technicianId) query.technicianId = technicianId;
    if (customerId) query.customerId = customerId;

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
      .populate("customerId", "email")
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
        result: "No ratings match the criteria",
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
      result: error.message,
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
      .populate("customerId", "email")
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
        .json({ success: false, message: "Rating not found", result: "No rating exists with this ID" });

    res.status(200).json({
      success: true,
      message: "Rating fetched successfully",
      result: rating,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message,
    });
  }
};

/* ===============================
   UPDATE RATING
   =============================== */
export const updateRating = async (req, res) => {
  try {
    const { id } = req.params;

    const rating = await Rating.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!rating) {
      return res.status(404).json({
        success: false,
        message: "Rating not found",
        result: "No rating exists with this ID",
      });
    }

    res.status(200).json({
      success: true,
      message: "Rating updated successfully",
      result: rating,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message,
    });
  }
};

/* ===============================
   DELETE RATING
   =============================== */
export const deleteRating = async (req, res) => {
  try {
    const { id } = req.params;

    const rating = await Rating.findByIdAndDelete(id);

    if (!rating) {
      return res.status(404).json({
        success: false,
        message: "Rating not found",
        result: "No rating exists with this ID",
      });
    }

    res.status(200).json({
      success: true,
      message: "Rating deleted successfully",
      result: "Rating has been deleted",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message,
    });
  }
};
