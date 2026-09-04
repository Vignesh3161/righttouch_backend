import express from "express";
import { Auth } from "../Middleware/Auth.js";
import { updatePermissions, getMyPermissions } from "../Controllers/permissionController.js";

/**
 * Role-scoped permission router factory (section 24).
 *
 * Mounted at BOTH /api/user/permissions (Customer) and
 * /api/technician/permissions (Technician). Identity always comes from the JWT
 * (req.user); we additionally enforce that the caller's role matches the mount
 * role so a Customer can never reach the Technician endpoint (and vice-versa).
 *
 * Never allow updating another user's permissions via a URL id — only the
 * authenticated principal's own state is writable.
 */
export const makePermissionRouter = (allowedRole) => {
  const router = express.Router();

  const enforceRole = (req, res, next) => {
    if (!req.user || req.user.role !== allowedRole) {
      return res.status(403).json({
        success: false,
        message: `${allowedRole} access only`,
        result: {},
      });
    }
    next();
  };

  router.use(enforceRole);

  router.put("/", updatePermissions);
  router.get("/", getMyPermissions);

  return router;
};

export default makePermissionRouter;
