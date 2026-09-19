import jwt from "jsonwebtoken";
import User from "../Schemas/User.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import { verifyTokenOptions } from "../Utils/token.js";

/**
 * Socket handshake auth — token is accepted ONLY from handshake.auth.
 * The query-string fallback is removed: tokens in URLs leak into proxy
 * logs, browser history and referrer headers (Socket Analysis B1.2).
 *
 * jwt.verify runs in the async callback form so a handshake flood cannot
 * block the event loop synchronously (Socket Analysis B1.3).
 */
export const socketAuth = (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;

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
            const user = await User.findById(decoded.userId).select("status").lean();
            if (!user || user.status === "Deleted") {
                return next(new Error("Authentication error: Account not found"));
            }
            if (user.status === "Blocked") {
                return next(new Error("Authentication error: Account blocked"));
            }

            let resolvedTechProfileId = decoded.technicianProfileId || null;

            if (decoded.role === "Technician") {
                // Resolve technicianProfileId from User if missing or validate consistency
                const techQuery = resolvedTechProfileId
                    ? TechnicianProfile.findById(resolvedTechProfileId)
                    : TechnicianProfile.findOne({ userId: decoded.userId });

                const techProfile = await techQuery.select("_id workStatus userId").lean();

                if (techProfile) {
                    // VALIDATION: Ensure techProfile.userId matches decoded.userId
                    if (String(techProfile.userId) !== String(decoded.userId)) {
                        console.error(`❌ [AUTH VALIDATION] Token techProfileId ${techProfile._id} belongs to user ${techProfile.userId}, but token userId is ${decoded.userId}`);
                        resolvedTechProfileId = techProfile._id;
                    } else {
                        resolvedTechProfileId = techProfile._id;
                    }

                    if (techProfile.workStatus === "deleted") {
                        return next(new Error("Authentication error: Account not found"));
                    }
                }
            }

            socket.user = {
                _id: decoded.userId,
                userId: decoded.userId,
                role: decoded.role,
                email: decoded.email,
                technicianProfileId: resolvedTechProfileId,
            };
            next();
        } catch (e) {
            return next(new Error("Authentication error"));
        }
    });
};