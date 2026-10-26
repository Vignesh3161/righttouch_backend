import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  listPrivilegedUsers,
  createPrivilegedUser,
  changeUserRole,
} from "../Services/adminUserService.js";

/**
 * Owner-only privileged user management.
 * Mounted at /api/admin -> POST /api/admin/users, PATCH /api/admin/users/:id/role.
 * Admin accounts are never allowed to create or promote other privileged users.
 */
const router = express.Router();

router.use(Auth, authorizeRoles("Owner"));

// GET /api/admin/users — list current Owner/Admin team
router.get("/users", async (req, res) => {
  try {
    const users = await listPrivilegedUsers({ actor: req.user });
    return res.status(200).json({
      success: true,
      message: "Privileged users fetched",
      result: users,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to fetch privileged users",
      code: err.code,
      details: err.details,
      result: {},
    });
  }
});

// POST /api/admin/users — create an Admin or Owner
router.post("/users", async (req, res) => {
  try {
    const user = await createPrivilegedUser({ actor: req.user, body: req.body || {} });
    return res.status(201).json({
      success: true,
      message: `${user.role} account created successfully`,
      result: user,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to create privileged user",
      code: err.code,
      details: err.details,
      result: {},
    });
  }
});

// PATCH /api/admin/users/:id/role — change an Admin/Owner role
router.patch("/users/:id/role", async (req, res) => {
  try {
    const user = await changeUserRole({
      actor: req.user,
      targetUserId: req.params.id,
      role: req.body?.role,
      reason: req.body?.reason,
    });
    return res.status(200).json({
      success: true,
      message: `Role updated to ${user.role}. Existing sessions were revoked.`,
      result: user,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to change user role",
      code: err.code,
      details: err.details,
      result: {},
    });
  }
});

export default router;
