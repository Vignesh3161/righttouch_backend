import jwt from "jsonwebtoken";

/**
 * Socket handshake auth — token is accepted ONLY from handshake.auth.
 * The query-string fallback is removed: tokens in URLs leak into proxy
 * logs, browser history and referrer headers (Socket Analysis B1.2).
 *
 * jwt.verify runs in the async callback form so a handshake flood cannot
 * block the event loop synchronously (Socket Analysis B1.3).
 */
export const socketAuth = (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
        return next(new Error("Authentication error: Token required"));
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return next(new Error("Authentication error: Invalid token"));
        }
        socket.user = decoded; // Attach user to socket
        next();
    });
};