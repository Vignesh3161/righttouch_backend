import jwt from "jsonwebtoken";
import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

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

    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });

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

    // 🔒 Extra check for technicians: also block if profile is soft-deleted
    if (decoded.role === "Technician" && decoded.technicianProfileId) {
      const techProfile = await TechnicianProfile.findById(decoded.technicianProfileId).select("workStatus").lean();
      if (techProfile?.workStatus === "deleted") {
        return res.status(403).json({ success: false, message: "User not found", result: {} });
      }
    }

    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      email: decoded.email,
      technicianProfileId: decoded.technicianProfileId || null,
    };

    next();
  } catch (err) {
    console.error("Auth Middleware - Error:", err.message, "Secret used:", process.env.JWT_SECRET ? `[length: ${process.env.JWT_SECRET.length}]` : "undefined");
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
