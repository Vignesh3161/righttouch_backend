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
    const user = await User.findById(decoded.userId).select("status role tokenVersion").lean();

    if (!user) {
      return res.status(401).json({ success: false, message: "Account not found", result: {} });
    }

    if (user.status === "Deleted") {
      return res.status(403).json({ success: false, message: "User not found", result: {} });
    }

    if (user.status === "Blocked") {
      return res.status(403).json({ success: false, message: "This account has been blocked. Contact support.", result: {} });
    }

    // H4: token-generation check — password change, role change, or explicit
    // revocation bumps User.tokenVersion and kills all older tokens. Missing
    // on both sides (legacy) ⇒ 0 ⇒ compatible.
    if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ success: false, message: "Session revoked. Please login again.", result: {} });
    }

    // H4: the AUTHORITATIVE role comes from the database, never from the
    // token claim — a demoted Admin's old token cannot keep privileges.
    const effectiveRole = user.role || decoded.role;

    let resolvedTechProfileId = null;

    // 🔒 Extra check for technicians: also block if profile is soft-deleted, and auto-resolve profile ID if missing
    if (effectiveRole === "Technician") {
      // H6: resolve the profile from the authenticated user identity, never
      // from a client-influenced token claim. A stale/forged profile id in
      // the token is discarded, not trusted.
      const techProfile = await TechnicianProfile.findOne({ userId: decoded.userId })
        .select("_id workStatus")
        .lean();
      if (techProfile) {
        resolvedTechProfileId = techProfile._id;
        if (techProfile.workStatus === "deleted") {
          return res.status(403).json({ success: false, message: "User not found", result: {} });
        }
        // H5: suspended technicians lose HTTP access consistently (socket
        // handshake and isTechnician enforce the same rule).
        if (techProfile.workStatus === "suspended") {
          return res.status(403).json({ success: false, message: "Technician account suspended. Contact support.", result: {} });
        }
      }
    }

    req.user = {
      _id: decoded.userId,
      userId: decoded.userId,
      role: effectiveRole,
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
