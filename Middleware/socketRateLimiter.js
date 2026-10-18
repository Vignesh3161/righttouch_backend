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

// H3: resolve the limiter key WITHOUT trusting client-controlled headers by
// default. `handshake.address` is the direct TCP peer and cannot be spoofed.
// X-Forwarded-For is honored ONLY when the operator explicitly configures
// TRUST_PROXY to the real proxy hop count — mirroring Express's `trust
// proxy` semantics (take the entry `hops` deep from the right, never the
// leftmost). Operator requirement: TRUST_PROXY must equal the exact number
// of trusted reverse proxies, otherwise per-client limiting is either
// evadable (too high) or unfairly shared (too low / unset behind a proxy).
export const getSocketIp = (socket) => {
    const direct = socket.handshake.address || "unknown";
    const raw = process.env.TRUST_PROXY;
    const hops = raw === "true" ? 1 : Number.parseInt(raw, 10);
    if (!Number.isFinite(hops) || hops <= 0) return direct;
    const xff = socket.handshake.headers?.["x-forwarded-for"];
    if (typeof xff !== "string" || !xff.trim()) return direct;
    const chain = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (chain.length < hops) return direct;
    return chain[chain.length - hops] || direct;
};

export const createHandshakeLimiter = ({
    max = 20,
    windowMs = 60000,
} = {}) => {
    return (socket, next) => {
        const now = Date.now();
        // NOTE: still per-process — move to Redis for true multi-server limits.
        const ip = getSocketIp(socket);

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