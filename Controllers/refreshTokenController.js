import jwt from "jsonwebtoken";
import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import {
  rotateRefreshToken,
  revokeAllForUser,
  revokeFamilyBySid,
  revokeRefreshTokenFamily,
} from "../Services/refreshTokenService.js";
import {
  issueSessionForUser,
  bumpTokenVersion,
} from "../Services/authService.js";
import {
  signToken,
  accessTokenExpiresIn,
  durationToSeconds,
  verifyTokenOptions,
} from "../Utils/token.js";
import { getIo } from "../Utils/ioAccess.js";
import { replaceSocketSession } from "../Utils/socketSessionControl.js";

const ok = (res, status, message, result = {}) =>
  res.status(status).json({ success: true, message, result });

const fail = (res, err) =>
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || "Internal server error",
    code: err.code || "SERVER_ERROR",
    ...(err.details ? { details: err.details } : {}),
  });

const sessionResponse = ({ token, refreshToken, expiresInSeconds, role, userId }) => ({
  token,
  refresh_token: refreshToken,
  refreshToken,
  expires_in: expiresInSeconds,
  role,
  userId,
});

const requestMeta = (req) => ({
  ip: req.ip,
  userAgent: req.get ? req.get("user-agent") : "",
});

const readBodyToken = (req) =>
  req.body?.refresh_token || req.body?.refreshToken || null;

const readBearerToken = (req) => {
  const header = req.headers?.authorization || "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
};

const technicianProfileIdFor = async (user) => {
  if (user.role !== "Technician") return null;
  const profile = await TechnicianProfile.findOne({ userId: user._id })
    .select("_id workStatus")
    .lean();
  if (!profile) return null;
  return profile._id;
};

/**
 * POST /api/user/auth/refresh
 *
 * Preferred: rotating opaque refresh token in the body.
 * Legacy upgrade: a still-valid Bearer access token with no refresh token yet.
 */
export const refreshSession = async (req, res) => {
  try {
    const rawToken = readBodyToken(req);

    if (rawToken) {
      const rotated = await rotateRefreshToken({
        rawToken,
        meta: requestMeta(req),
      });
      const technicianProfileId = await technicianProfileIdFor(rotated.user);
      const expiresIn = accessTokenExpiresIn(rotated.user.role);
      const token = signToken(
        {
          userId: rotated.user._id,
          role: rotated.user.role,
          tokenVersion: rotated.tokenVersion,
          sid: rotated.familyId,
          ...(technicianProfileId
            ? { technicianProfileId }
            : {}),
        },
        { expiresIn }
      );

      return ok(res, 200, "Token refreshed", sessionResponse({
        token,
        refreshToken: rotated.refreshToken,
        expiresInSeconds:
          durationToSeconds(expiresIn) ?? rotated.expiresInSeconds,
        role: rotated.user.role,
        userId: rotated.user._id,
      }));
    }

    // Legacy session upgrade: access token is valid but this client has not
    // received a refresh token yet (e.g. session predates the deployment).
    const accessToken = readBearerToken(req);
    if (!accessToken) {
      const err = new Error("Refresh token required");
      err.statusCode = 400;
      err.code = "REFRESH_TOKEN_REQUIRED";
      throw err;
    }

    let decoded;
    try {
      decoded = jwt.verify(
        accessToken,
        process.env.JWT_SECRET,
        verifyTokenOptions()
      );
    } catch (e) {
      const err = new Error("Invalid or expired access token");
      err.statusCode = 401;
      err.code = "INVALID_ACCESS_TOKEN";
      throw err;
    }

    const user = await User.findById(decoded.userId)
      .select("role status tokenVersion")
      .lean();
    if (!user) {
      const err = new Error("Account not found");
      err.statusCode = 401;
      err.code = "ACCOUNT_NOT_FOUND";
      throw err;
    }
    if (user.status === "Blocked" || user.status === "Deleted") {
      const err = new Error("Account unavailable");
      err.statusCode = 403;
      err.code = user.status === "Blocked" ? "ACCOUNT_BLOCKED" : "ACCOUNT_DELETED";
      throw err;
    }
    if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      const err = new Error("Session revoked. Please login again.");
      err.statusCode = 401;
      err.code = "SESSION_REVOKED";
      throw err;
    }

    const technicianProfileId = await technicianProfileIdFor(user);
    const session = await issueSessionForUser({
      user,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 0,
      technicianProfileId,
      meta: requestMeta(req),
      replaceExistingSessions: false,
    });

    return ok(res, 200, "Session upgraded", sessionResponse({
      ...session,
      role: user.role,
      userId: user._id,
    }));
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /api/user/auth/logout
 *
 * Revokes only the current device. Accepts either the refresh token in the
 * body or a valid Bearer access token carrying `sid`. Idempotent by design.
 */
export const logoutSession = async (req, res) => {
  try {
    const rawToken = readBodyToken(req);
    if (rawToken) {
      await revokeRefreshTokenFamily(rawToken, "logout");
      return ok(res, 200, "Logged out successfully");
    }

    const accessToken = readBearerToken(req);
    if (accessToken) {
      try {
        const decoded = jwt.verify(
          accessToken,
          process.env.JWT_SECRET,
          verifyTokenOptions()
        );
        if (decoded.sid) {
          await revokeFamilyBySid({
            userId: decoded.userId,
            sid: decoded.sid,
            reason: "logout",
          });
        }
      } catch (e) {
        // Expired/legacy access token: there is nothing safe to revoke here.
        // Local client cleanup remains authoritative.
      }
    }

    return ok(res, 200, "Logged out successfully");
  } catch (err) {
    return fail(res, err);
  }
};

/**
 * POST /api/user/auth/logout-all
 *
 * Auth middleware required. Kills every device and bumps tokenVersion so any
 * access token issued earlier is rejected immediately.
 */
export const logoutAllSessions = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      const err = new Error("Authentication required");
      err.statusCode = 401;
      err.code = "UNAUTHORIZED";
      throw err;
    }

    await revokeAllForUser(userId, "logout_all");
    await bumpTokenVersion(userId);
    replaceSocketSession(
      getIo(),
      userId,
      "You have been logged out on all devices."
    );

    return ok(res, 200, "Logged out from all devices");
  } catch (err) {
    return fail(res, err);
  }
};
