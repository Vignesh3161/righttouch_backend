import mongoose from "mongoose";

/**
 * Middleware to ensure the authenticated user is a Customer with valid userId
 * Must be used AFTER Auth middleware
 */
export const ensureCustomer = (req, res, next) => {
  try {
    // Check if user exists and has Customer role
    if (!req.user || req.user.role !== "Customer") {
      return res.status(403).json({
        success: false,
        message: "Customer access only",
        result: {},
      });
    }

    // Check if userId exists and is valid ObjectId
    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({
        success: false,
        message: "Invalid or missing customer ID in token",
        result: {},
      });
      
    }

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Authorization check failed",
      result: { reason: error.message },
    });
  }
};
