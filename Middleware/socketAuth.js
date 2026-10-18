import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { verifyTokenOptions } from "../Utils/token.js";

const mongooseTypesObjectIdValid = (v) => {
  try {
    return mongoose.Types.ObjectId.isValid(v);
  } catch {
    return false;
  }
};

/**
 * Socket handshake auth — token is accepted ONLY from handshake.auth.
 * The query-string fallback is removed: tokens in URLs leak into proxy
 * logs, browser history and referrer headers (Socket Analysis B1.2).
 *
 * jwt.verify runs in the async callback form so a handshake flood cannot
 * block the event loop synchronously (Socket Analysis B1.3).
 */
export const socketAuth = (socket, next) => {
    // Tokens ONLY from handshake.auth — never from query string (URLs leak
    // into proxy logs, browser history and referrer headers).
    const token = socket.handshake.auth?.token;

    if (!token) {
        return next(new Error("Authentication error: Token required"));
    }

    jwt.verify(token, process.env.JWT_SECRET, verifyTokenOptions(), async (err, decoded) => {
        if (err) {
            return next(new Error("Authentication error: Invalid token"));
        }
        try {
            // Mirror HTTP Auth: block Deleted/Blocked accounts even with a
            // still-valid token so banned users lose real-time access too.
            const user = await User.findById(decoded.userId).select("status role tokenVersion").lean();
            if (!user || user.status === "Deleted") {
                return next(new Error("Authentication error: Account not found"));
            }
            if (user.status === "Blocked") {
                return next(new Error("Authentication error: Account blocked"));
            }

            // H4: same revocation generation check as HTTP Auth — a password
            // change, role change, or explicit revocation kills live sockets;
            // the client must re-authenticate (which re-runs this handshake).
            if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
                return next(new Error("Authentication error: Session revoked"));
            }

            // H4: authoritative role from the database, never the token claim.
            const effectiveRole = user.role || decoded.role;

            let resolvedTechProfileId = null;

            if (effectiveRole === "Technician") {
                // H6: FAIL CLOSED on identity mismatch. The profile is resolved
                // strictly from the authenticated user id; a token-carried
                // profile id belonging to someone else is rejected — never
                // adopted, never "fixed up" with a warning.
                if (
                    decoded.technicianProfileId &&
                    mongooseTypesObjectIdValid(decoded.technicianProfileId)
                ) {
                    const claimed = await TechnicianProfile.findById(decoded.technicianProfileId)
                        .select("_id userId")
                        .lean();
                    if (claimed && String(claimed.userId) !== String(decoded.userId)) {
                        console.error(
                            `❌ [AUTH VALIDATION] Rejecting socket: token techProfileId ${claimed._id} belongs to user ${claimed.userId}, but token userId is ${decoded.userId}`
                        );
                        return next(new Error("Authentication error: Profile mismatch"));
                    }
                }

                const techProfile = await TechnicianProfile.findOne({ userId: decoded.userId })
                    .select("_id workStatus")
                    .lean();

                if (!techProfile) {
                    return next(new Error("Authentication error: Technician profile not found"));
                }
                if (techProfile.workStatus === "deleted") {
                    return next(new Error("Authentication error: Account not found"));
                }
                // H5: suspended technicians cannot hold or reopen sockets —
                // matches the HTTP Auth rule and the suspend-time forced
                // disconnect, so reconnect never restores privileges.
                if (techProfile.workStatus === "suspended") {
                    return next(new Error("Authentication error: Account suspended"));
                }
                resolvedTechProfileId = techProfile._id;
            }

            socket.user = {
                _id: decoded.userId,
                userId: decoded.userId,
                role: effectiveRole,
                email: decoded.email,
                technicianProfileId: resolvedTechProfileId,
            };
            next();
        } catch (e) {
            return next(new Error("Authentication error"));
        }
    });
};