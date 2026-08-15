/**
 * 📊 SOCKET METRICS (minimal, dependency-free)
 * Closes Socket Analysis B2.4. Counters are exported and logged periodically;
 * wire into whatever dashboard/logger exists — a log line tailed by one is
 * enough to have a signal before the first support ticket.
 */

const metrics = {
    acksTotal: 0,
    ackTimeouts: 0,
};

export const recordAck = (timedOut) => {
    metrics.acksTotal += 1;
    if (timedOut) metrics.ackTimeouts += 1;
};

export const getSocketMetrics = () => ({
    ...metrics,
    ackTimeoutRate: metrics.acksTotal > 0 ? metrics.ackTimeouts / metrics.acksTotal : 0,
});

export const resetSocketMetrics = () => {
    metrics.acksTotal = 0;
    metrics.ackTimeouts = 0;
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