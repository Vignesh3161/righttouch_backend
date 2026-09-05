/**
 * 📊 SOCKET METRICS (minimal, dependency-free)
 * Closes Socket Analysis B2.4. Counters are exported and logged periodically;
 * wire into whatever dashboard/logger exists — a log line tailed by one is
 * enough to have a signal before the first support ticket.
 *
 * 📍 Location counters (Location Pipeline):
 *   locUpdates     — accepted location pings (socket + http)
 *   httpLocUpdates — pings that arrived via PUT /api/technician/location
 *                    (high ratio = app bypassing the socket channel)
 *   locDrops       — pings dropped by the socket.use() limiter (1/5s per tech)
 */

const metrics = {
    acksTotal: 0,
    ackTimeouts: 0,
    locUpdates: 0,
    locDrops: 0,
    httpLocUpdates: 0,
};

export const recordAck = (timedOut) => {
    metrics.acksTotal += 1;
    if (timedOut) metrics.ackTimeouts += 1;
};

export const recordLocationUpdate = (via = "socket") => {
    metrics.locUpdates += 1;
    if (via === "http") metrics.httpLocUpdates += 1;
};

export const recordLocationDrop = () => {
    metrics.locDrops += 1;
};

export const getSocketMetrics = () => ({
    ...metrics,
    ackTimeoutRate: metrics.acksTotal > 0 ? metrics.ackTimeouts / metrics.acksTotal : 0,
});

export const resetSocketMetrics = () => {
    metrics.acksTotal = 0;
    metrics.ackTimeouts = 0;
    metrics.locUpdates = 0;
    metrics.locDrops = 0;
    metrics.httpLocUpdates = 0;
};

/**
 * Start a periodic metric logger. Returns the interval so the caller can
 * clear it on shutdown.
 */
export const startSocketMetricsLogger = (io, intervalMs = 60000) => {
    return setInterval(() => {
        console.log("📊 socket_metrics", {
            connectedSockets: io?.engine?.clientsCount ?? 0,
            ...getSocketMetrics(),
        });
        resetSocketMetrics();
    }, intervalMs).unref?.();
};