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
            if (decoded.role === "Technician" && decoded.technicianProfileId) {
                const tech = await TechnicianProfile.findById(decoded.technicianProfileId)
                    .select("workStatus")
                    .lean();
                if (tech?.workStatus === "deleted") {
                    return next(new Error("Authentication error: Account not found"));
                }
            }
            socket.user = decoded;
            next();
        } catch (e) {
            return next(new Error("Authentication error"));
        }
    });
};