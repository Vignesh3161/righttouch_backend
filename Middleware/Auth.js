import jwt from "jsonwebtoken";
import UserSchema from "../Schemas/User.js";// ✅ Import User Schema properly

export const Auth = async (req, res, next) => {      // 🔹 Token validation middleware
  const token = req.headers.token; // frontend should send header: { token: "<jwt_token>" }

  if (!token) {
    return res.status(401).json({ success: false, message: "Authorization token required", result: "Missing authorization token" });
  }

  try {
    // Verify the token using JWT_SECRET key
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach decoded info (userId, email, role) to request
    req.user = decoded;

    next(); // continue to next middleware / controller
  } catch (err) {
    return res.status(401).json({ success: false, message: "Token invalid or expired", result: "Authentication failed" });
  }
};

// 🔹 Role-based access middleware
export const authorizeRoles = (...allowedRoles) => {
  return async (req, res, next) => {
    const token = req.headers.token;

    if (!token) {
      return res.status(401).json({ success: false, message: "Authorization token required", result: "Missing authorization token" });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // ✅ Note: use userId, not id
      const user = await UserSchema.findById(decoded.userId).select("-password");

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found", result: "No user exists with this ID" });
      }

      // ✅ Case-insensitive role check
      const isAllowed = allowedRoles
        .map((r) => r.toLowerCase())
        .includes(user.role.toLowerCase());

      if (!isAllowed) {
        return res
          .status(403)
          .json({ success: false, message: `Access denied: ${allowedRoles.join(", ")} only`, result: "Insufficient permissions" });
      }

      // Attach user info to request
      req.user = user;
      next();
    } catch (error) {
      return res.status(401).json({ success: false, message: "Token invalid or expired", result: "Authentication failed" });
    }
  };
};
