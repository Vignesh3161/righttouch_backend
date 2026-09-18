/**
 * 📊 NOTIFICATION DELIVERY METRICS — lightweight in-memory counters + structured logs.
 * Extend with Prometheus/StatsD later if needed. No external deps.
 */

const metrics = {
  counters: {
    outbox_processed: 0,
    outbox_completed: 0,
    outbox_failed: 0,
    outbox_retried: 0,
    delivery_attempted: 0,
    delivery_success: 0,
    delivery_failed_transient: 0,
    delivery_failed_permanent: 0,
    delivery_dead_letter: 0,
    socket_emitted: 0,
    push_sent: 0,
    push_skipped: 0,
    sms_sent: 0,
    channel_unknown: 0,
    fcm_project_mismatch: 0,
  },
  latenciesMs: {
    outbox_tick: [],
    delivery_dispatch: [],
  },
  maxLatencySamples: 1000,

  increment(key, delta = 1) {
    if (metrics.counters.hasOwnProperty(key)) {
      metrics.counters[key] += delta;
    }
  },

  recordLatency(bucket, ms) {
    const arr = metrics.latenciesMs[bucket];
    if (arr) {
      arr.push(ms);
      if (arr.length > metrics.maxLatencySamples) arr.shift();
    }
  },

  getSummary() {
    const summary = { counters: { ...metrics.counters } };
    for (const [bucket, arr] of Object.entries(metrics.latenciesMs)) {
      if (arr.length === 0) continue;
      const sorted = [...arr].sort((a, b) => a - b);
      summary[bucket] = {
        count: sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
        max: sorted[sorted.length - 1],
        avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      };
    }
    return summary;
  },

  reset() {
    for (const k of Object.keys(metrics.counters)) metrics.counters[k] = 0;
    for (const k of Object.keys(metrics.latenciesMs)) metrics.latenciesMs[k] = [];
  },
};

const logDelivery = (channel, result, payload, durationMs) => {
  const status = result.ok ? "SUCCESS" : (result.permanent ? "PERMANENT_FAIL" : "TRANSIENT_FAIL");
  const log = {
    ts: new Date().toISOString(),
    channel,
    status,
    durationMs,
    providerMessageId: result.providerMessageId,
    error: result.error,
    recipientId: payload.recipientId || payload.phoneNumber,
    recipientType: payload.recipientType,
  };
  console.log(`📬 [DELIVERY] ${channel} | ${status} | ${durationMs}ms`, log);
};

const logOutbox = (event, outboxId, details = {}) => {
  const log = {
    ts: new Date().toISOString(),
    event,
    outboxId,
    ...details,
  };
  console.log(`📦 [OUTBOX] ${event}`, log);
};

export const notificationMetrics = metrics;
export { logDelivery, logOutbox };