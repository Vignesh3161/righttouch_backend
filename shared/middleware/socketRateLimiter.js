/**
 * 🛡 SOCKET HANDSHAKE RATE LIMITER (fixed-window, per-IP)
 * Closes Socket Analysis B1.3: the /socket.io path is skipped by the HTTP
 * rate limiters, so handshakes were previously unbounded (each one costs a
 * jwt.verify). This middleware MUST run BEFORE io.use(socketAuth) so a
 * flood of junk tokens never reaches the verifier.
 *
 * Fixed-window counters (count + resetAt per IP) instead of timestamp
 * arrays: memory per IP is O(1), so a handshake flood cannot turn the
 * limiter itself into a memory-DoS vector.
 *
 * In-memory is correct for the current single-instance deployment; if the
 * app ever scales horizontally this must move to a shared store (Redis).
 */

const windows = new Map(); // ip -> { count: number, resetAt: number }

// Expired windows are dropped on this sweep; live ones are untouched.
const sweep = (now) => {
    for (const [ip, w] of windows) {
        if (w.resetAt <= now) windows.delete(ip);
    }
};

setInterval(() => sweep(Date.now()), 60000).unref?.();

export const createHandshakeLimiter = ({
    max = 20,
    windowMs = 60000,
} = {}) => {
    return (socket, next) => {
        const now = Date.now();
        // Consistent with HTTP getClientIp(): prefer X-Forwarded-For when behind
        // a proxy (Render/Nginx), else the direct socket address.
        // NOTE: still per-process — move to Redis for true multi-server limits.
        const xff = socket.handshake.headers?.["x-forwarded-for"];
        const ip =
          (typeof xff === "string" && xff.split(",")[0].trim()) ||
          socket.handshake.address ||
          "unknown";

        let w = windows.get(ip);
        if (!w || w.resetAt <= now) {
            w = { count: 0, resetAt: now + windowMs };
            windows.set(ip, w);
        }

        if (w.count >= max) {
            return next(new Error("Too many connection attempts"));
        }

        w.count += 1;
        next();
    };
};
