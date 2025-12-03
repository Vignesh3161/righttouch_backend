import Rating from "../Schemas/Rating.js";

// Create new rating
export const userRating = async (req, res) => {
  try {
    const { technicianId, serviceId, customerId, rates, comment } = req.body;

    if (!serviceId || !customerId || !rates || !comment) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const ratingData = await Rating.create({
      technicianId,
      serviceId,
      customerId,
      rates,
      comment,
    });

    res.status(201).json({
      message: "Rating created successfully",
      data: ratingData,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server Error",
      error: error.message,
    });
  }
};

export const getAllRatings = async (req, res) => {
  try {
    const { search, serviceId, technicianId, customerId } = req.query;

    let query = {};

    if (search) {
      const searchAsNumber = Number(search);

      query.$or = [{ comment: { $regex: search, $options: "i" } }];

      if (!isNaN(searchAsNumber)) {
        query.$or.push({ rates: searchAsNumber });
      }
    }

    const ratings = await Rating.find(query)
      .populate("serviceId", "serviceName")
      .populate("customerId", "email name")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "username email" },
      });
    
    if (services.length === 0) {
      return res.status(404).json({
        message: "No rating data found",
      });
    }
    return res.status(200).json({
      success: true,
      message: "Ratings fetched successfully",
      data: ratings,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};

// ✅ Get Rating by ID
export const getRatingById = async (req, res) => {
  try {
    const { id } = req.params;
    const rating = await Rating.findById(id)
      .populate("serviceId", "serviceName")
      .populate("customerId", "email")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "username email" },
      });
    
    if (rating.length === 0) {
      return res.status(404).json({
        message: "No rating data found",
      });
    }
    if (!rating)
      return res
        .status(404)
        .json({ success: false, message: "Rating not found" });

    res.status(200).json({ success: true, data: rating });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const updateRating = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const rating = await Rating.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!rating)
      return res
        .status(404)
        .json({ success: false, message: "Rating not found" });

    res.status(200).json({ success: true, data: rating });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const deleteRating = async (req, res) => {
  try {
    const { id } = req.params;
    const rating = await Rating.findByIdAndDelete(id);

    if (!rating)
      return res
        .status(404)
        .json({ success: false, message: "Rating not found" });

    res
      .status(200)
      .json({ success: true, message: "Rating deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
