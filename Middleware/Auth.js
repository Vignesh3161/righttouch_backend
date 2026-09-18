import jwt from "jsonwebtoken";
import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { verifyTokenOptions } from "../Utils/token.js";

export const Auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, verifyTokenOptions());

    // 🔒 DB check: block deleted/blocked users even if token is still valid
    const user = await User.findById(decoded.userId).select("status role").lean();

    if (!user) {
      return res.status(401).json({ success: false, message: "Account not found", result: {} });
    }

    if (user.status === "Deleted") {
      return res.status(403).json({ success: false, message: "User not found", result: {} });
    }

    if (user.status === "Blocked") {
      return res.status(403).json({ success: false, message: "This account has been blocked. Contact support.", result: {} });
    }

    let resolvedTechProfileId = decoded.technicianProfileId || null;

    // 🔒 Extra check for technicians: also block if profile is soft-deleted, and auto-resolve profile ID if missing
    if (decoded.role === "Technician") {
      const techQuery = resolvedTechProfileId
        ? TechnicianProfile.findById(resolvedTechProfileId)
        : TechnicianProfile.findOne({ userId: decoded.userId });

      const techProfile = await techQuery.select("_id workStatus").lean();
      if (techProfile) {
        resolvedTechProfileId = techProfile._id;
        if (techProfile.workStatus === "deleted") {
          return res.status(403).json({ success: false, message: "User not found", result: {} });
        }
      }
    }

    req.user = {
      _id: decoded.userId,
      userId: decoded.userId,
      role: decoded.role,
      email: decoded.email,
      technicianProfileId: resolvedTechProfileId,
    };

    next();
  } catch (err) {
    console.error("Auth Middleware - Error:", err.message);
    return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
  }
};


// 🔹 Role-based access middleware
export const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    // Auth middleware MUST run before this
    if (!req.user || !req.user.role) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const isAllowed = allowedRoles
      .map((r) => r.toLowerCase())
      .includes((req.user.role || "").toLowerCase());

    if (!isAllowed) {
      return res.status(403).json({ success: false, message: `Access denied: ${allowedRoles.join(", ")} only` });
    }

    next();
  };
};
