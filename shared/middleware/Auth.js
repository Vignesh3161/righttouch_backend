import jwt from "jsonwebtoken";
import { verifyTokenOptions } from "../../modules/identity/utils/token.js";
import { resolveAuthSubject, AuthSubjectError } from "./resolveAuth.js";

if (!process.env.JWT_SECRET) {
  // Fail-visible, not fail-silent: without a secret every request 401s.
  // Production boot already hard-fails via validateSecrets(); this covers the rest.
  console.error("❌ [Auth] JWT_SECRET is not set — all authenticated requests will fail.");
}

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

    // All DB policy (status / role-equality / tokenVersion / technician
    // workStatus) lives in the shared resolver — see resolveAuth.js.
    req.user = await resolveAuthSubject(decoded);

    next();
  } catch (err) {
    if (err instanceof AuthSubjectError) {
      return res
        .status(err.statusCode)
        .json({ success: false, message: err.message, result: {} });
    }
    console.error("Auth Middleware - Error:", err.message);
    return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
  }
};


// 🔹 Role-based access middleware
export const authorizeRoles = (...allowedRoles) => {
  // Precomputed once per route registration instead of .map() per request.
  const allowed = new Set(allowedRoles.map((r) => String(r).toLowerCase()));
  return (req, res, next) => {
    // Auth middleware MUST run before this
    if (!req.user || !req.user.role) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    if (!allowed.has(String(req.user.role).toLowerCase())) {
      return res.status(403).json({ success: false, message: `Access denied: ${allowedRoles.join(", ")} only` });
    }

    next();
  };
};
