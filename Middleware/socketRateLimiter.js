/**
 * 🛡 SOCKET HANDSHAKE RATE LIMITER (in-memory, per-IP)
 * Closes Socket Analysis B1.3: the /socket.io path is skipped by the HTTP
 * rate limiters, so handshakes were previously unbounded (each one costs a
 * jwt.verify). This middleware MUST run BEFORE io.use(socketAuth) so a
 * flood of junk tokens never reaches the verifier.
 *
 * In-memory is correct for the current single-instance deployment; if the
 * app ever scales horizontally this must move to a shared store (Redis).
 */

const attemptBuckets = new Map(); // ip -> number[] (timestamps)

const sweep = (now, windowMs) => {
    for (const [ip, timestamps] of attemptBuckets) {
        const kept = timestamps.filter((t) => now - t < windowMs);
        if (kept.length === 0) attemptBuckets.delete(ip);
        else attemptBuckets.set(ip, kept);
    }
};

setInterval(() => sweep(Date.now(), 60000), 60000).unref?.();

export const createHandshakeLimiter = ({
    max = 20,
    windowMs = 60000,
} = {}) => {
    return (socket, next) => {
        const now = Date.now();
        const ip = socket.handshake.address || "unknown";

        const timestamps = (attemptBuckets.get(ip) || []).filter(
            (t) => now - t < windowMs
        );

        if (timestamps.length >= max) {
            return next(new Error("Too many connection attempts"));
        }

        timestamps.push(now);
        attemptBuckets.set(ip, timestamps);
        next();
    };
};