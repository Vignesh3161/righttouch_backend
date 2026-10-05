import jwt from "jsonwebtoken";
import { verifyTokenOptions } from "../../modules/identity/utils/token.js";
import { resolveAuthSubject, AuthSubjectError } from "./resolveAuth.js";

/**
 * Socket handshake auth — token is accepted ONLY from handshake.auth.
 * The query-string fallback is removed: tokens in URLs leak into proxy
 * logs, browser history and referrer headers (Socket Analysis B1.2).
 *
 * jwt.verify runs in the async callback form so a handshake flood cannot
 * block the event loop synchronously (Socket Analysis B1.3).
 *
 * DB policy (Deleted/Blocked/Inactive, role-equality, tokenVersion,
 * technician workStatus + ownership) is shared with HTTP Auth via
 * resolveAuth.js — the two gates can no longer drift apart.
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
            const subject = await resolveAuthSubject(decoded);
            socket.user = {
                _id: subject.userId,
                userId: subject.userId,
                role: subject.role,
                email: subject.email,
                technicianProfileId: subject.technicianProfileId,
                sid: subject.sid || null,
            };
            // P5: binds this connection to its AuthSession so per-session
            // logout can disconnect exactly this device's socket. Legacy
            // tokens resolve sid null (compat path, unchanged behavior).
            socket.sessionId = subject.sid || null;
            next();
        } catch (e) {
            if (e instanceof AuthSubjectError) {
                // Preserve the historical client-visible distinctions.
                if (e.code === "ACCOUNT_BLOCKED" || e.code === "TECHNICIAN_SUSPENDED") {
                    const reason =
                        e.code === "ACCOUNT_BLOCKED" ? "Account blocked" : "Account suspended";
                    return next(new Error(`Authentication error: ${reason}`));
                }
                return next(new Error("Authentication error: Account not found"));
            }
            return next(new Error("Authentication error"));
        }
    });
};
