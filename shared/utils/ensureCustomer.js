import mongoose from "mongoose";

/**
 * Helper function to ensure the authenticated user is a Customer with valid userId
 * Throws an error if validation fails
 * Use this inside controller functions
 */
export const ensureCustomer = (req) => {
  if (!req.user || (req.user.role || "").toLowerCase() !== "customer") {
    const err = new Error("Customer access only");
    err.statusCode = 403;
    throw err;
  }

  if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
    const err = new Error("Invalid or missing customer ID in token");
    err.statusCode = 401;
    throw err;
  }
};

