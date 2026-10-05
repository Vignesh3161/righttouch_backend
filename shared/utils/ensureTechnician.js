import mongoose from "mongoose";

/**
 * Helper function to ensure the authenticated user is a Technician with valid technicianProfileId
 * Throws an error if validation fails
 * Use this inside controller functions
 */
export const ensureTechnician = (req) => {
    if (!req.user || (req.user.role || "").toLowerCase() !== "technician") {
        const err = new Error("Technician access only");
        err.statusCode = 403;
        throw err;
    }

    if (!req.user.technicianProfileId || !mongoose.Types.ObjectId.isValid(req.user.technicianProfileId)) {
        const err = new Error("Invalid or missing technician profile ID in token");
        err.statusCode = 401;
        throw err;
    }
};
