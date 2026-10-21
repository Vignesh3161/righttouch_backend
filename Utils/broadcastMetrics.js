/**
 * 📊 BROADCAST FUNNEL METRICS
 * Tracks the complete broadcast pipeline for observability
 */

const METRICS_WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window

class BroadcastMetrics {
  constructor() {
    this.counters = new Map(); // key -> { count, lastReset }
    this.histograms = new Map(); // key -> [values]
  }

  _getWindowKey(key) {
    const window = Math.floor(Date.now() / METRICS_WINDOW_MS);
    return `${key}:${window}`;
  }

  increment(key, value = 1) {
    const windowKey = this._getWindowKey(key);
    const current = this.counters.get(windowKey) || { count: 0, lastReset: Date.now() };
    current.count += value;
    this.counters.set(windowKey, current);
  }

  recordHistogram(key, value) {
    const windowKey = this._getWindowKey(key);
    const arr = this.histograms.get(windowKey) || [];
    arr.push(value);
    // Keep only last 1000 values per window
    if (arr.length > 1000) arr.shift();
    this.histograms.set(windowKey, arr);
  }

  getCounter(key) {
    const windowKey = this._getWindowKey(key);
    return this.counters.get(windowKey)?.count || 0;
  }

  getHistogramStats(key) {
    const windowKey = this._getWindowKey(key);
    const arr = this.histograms.get(windowKey) || [];
    if (arr.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, count: 0 };
    
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      count: sorted.length,
    };
  }

  getAllMetrics() {
    const metrics = {};
    for (const [key, value] of this.counters) {
      const baseKey = key.split(':')[0];
      if (!metrics[baseKey]) metrics[baseKey] = { count: 0 };
      metrics[baseKey].count += value.count;
    }
    for (const [key, value] of this.histograms) {
      const baseKey = key.split(':')[0];
      if (!metrics[baseKey]) metrics[baseKey] = {};
      metrics[baseKey].histogram = this.getHistogramStats(baseKey);
    }
    return metrics;
  }
}

export const broadcastMetrics = new BroadcastMetrics();

// Pre-defined metric keys
export const METRIC_KEYS = {
  // Booking creation
  BOOKING_CREATED: 'booking_created',
  BOOKING_CREATED_ERROR: 'booking_created_error',
  
  // Matching
  MATCHING_STARTED: 'matching_started',
  MATCHING_SUCCESS: 'matching_success',
  MATCHING_NO_TECHS: 'matching_no_techs',
  MATCHING_ERROR: 'matching_error',
  MATCHING_LEASE_ACQUIRED: 'matching_lease_acquired',
  MATCHING_LEASE_CONFLICT: 'matching_lease_conflict',
  
  // Eligibility
  TECHS_FOUND: 'techs_found',
  TECHS_ELIGIBLE: 'techs_eligible',
  TECHS_FILTERED_ZONE: 'techs_filtered_zone',
  TECHS_FILTERED_FEASIBILITY: 'techs_filtered_feasibility',
  TECHS_FILTERED_OTHER: 'techs_filtered_other',
  
  // Broadcast creation
  BROADCAST_CREATED: 'broadcast_created',
  BROADCAST_UPDATED: 'broadcast_updated',
  
  // Notifications
  SOCKET_EMITTED: 'socket_emitted',
  SOCKET_EMIT_FAILED: 'socket_emitted_failed',
  OUTBOX_CREATED: 'outbox_created',
  OUTBOX_FAILED: 'outbox_created_failed',
  
  // Delivery
  FCM_SENT: 'fcm_sent',
  FCM_FAILED: 'fcm_failed',
  SOCKET_DELIVERED: 'socket_delivered',
  SOCKET_OFFLINE: 'socket_offline',
  DEDUPE_SKIPPED: 'dedupe_skipped',
  
  // Acceptance
  ACCEPT_ATTEMPT: 'accept_attempt',
  ACCEPT_SUCCESS: 'accept_success',
  ACCEPT_VERSION_MISMATCH: 'accept_version_mismatch',
  ACCEPT_ELIGIBILITY_FAILED: 'accept_eligibility_failed',
  ACCEPT_FEASIBILITY_FAILED: 'accept_feasibility_failed',
  ACCEPT_ALREADY_TAKEN: 'accept_already_taken',
  ACCEPT_ERROR: 'accept_error',
  
  // Revalidation
  REVALIDATION_TRIGGERED: 'revalidation_triggered',
  REVALIDATION_EXPIRED: 'revalidation_expired',
  
  // Latency histograms
  MATCHING_LATENCY_MS: 'matching_latency_ms',
  BROADCAST_LATENCY_MS: 'broadcast_latency_ms',
  ACCEPT_LATENCY_MS: 'accept_latency_ms',
};

export function recordMetric(key, value = 1) {
  broadcastMetrics.increment(key, value);
}

export function recordHistogram(key, value) {
  broadcastMetrics.recordHistogram(key, value);
}

export function getBroadcastMetrics() {
  return broadcastMetrics.getAllMetrics();
}

/* ============================================================
   Delivery/outbox counters (5-minute rolling window like above)
   ============================================================ */
export const PIPELINE_METRIC_KEYS = {
  PUSH_ATTEMPTED: 'push_attempted',
  PUSH_SKIPPED: 'push_skipped',
  DISPATCH_PROCESSED: 'dispatch_processed',
  DISPATCH_DONE: 'dispatch_done',
  DISPATCH_RETRIED: 'dispatch_retried',
  DISPATCH_FAILED: 'dispatch_failed',
  DISPATCH_SKIPPED: 'dispatch_skipped',
  BOOKING_OUTBOX_PROCESSED: 'booking_outbox_processed',
  BOOKING_OUTBOX_DONE: 'booking_outbox_done',
  BOOKING_OUTBOX_RETRIED: 'booking_outbox_retried',
  BOOKING_OUTBOX_FAILED: 'booking_outbox_failed',
  BOOKING_OUTBOX_NO_CANDIDATES: 'booking_outbox_no_candidates',
  BOOKING_OUTBOX_LEASE_CONFLICT: 'booking_outbox_lease_conflict',
};

export const recordPush = ({ delivered = false, skipped = false, failed = false } = {}) => {
  recordMetric(PIPELINE_METRIC_KEYS.PUSH_ATTEMPTED);
  if (delivered) recordMetric(METRIC_KEYS.FCM_SENT);
  if (skipped) recordMetric(PIPELINE_METRIC_KEYS.PUSH_SKIPPED);
  if (failed) recordMetric(METRIC_KEYS.FCM_FAILED);
};

export const recordSocket = (delivered) => {
  if (delivered) recordMetric(METRIC_KEYS.SOCKET_DELIVERED);
  else recordMetric(METRIC_KEYS.SOCKET_EMIT_FAILED);
};

export const recordDispatch = (status) => {
  recordMetric(PIPELINE_METRIC_KEYS.DISPATCH_PROCESSED);
  if (status === "done") recordMetric(PIPELINE_METRIC_KEYS.DISPATCH_DONE);
  else if (status === "retried") recordMetric(PIPELINE_METRIC_KEYS.DISPATCH_RETRIED);
  else if (status === "failed") recordMetric(PIPELINE_METRIC_KEYS.DISPATCH_FAILED);
  else if (status === "skipped") recordMetric(PIPELINE_METRIC_KEYS.DISPATCH_SKIPPED);
};

export const recordBookingOutbox = (status) => {
  recordMetric(PIPELINE_METRIC_KEYS.BOOKING_OUTBOX_PROCESSED);
  if (status === "done") recordMetric(PIPELINE_METRIC_KEYS.BOOKING_OUTBOX_DONE);
  else if (status === "retried") recordMetric(PIPELINE_METRIC_KEYS.BOOKING_OUTBOX_RETRIED);
  else if (status === "failed") recordMetric(PIPELINE_METRIC_KEYS.BOOKING_OUTBOX_FAILED);
  else if (status === "no_candidates") recordMetric(PIPELINE_METRIC_KEYS.BOOKING_OUTBOX_NO_CANDIDATES);
  else if (status === "lease_conflict") recordMetric(PIPELINE_METRIC_KEYS.BOOKING_OUTBOX_LEASE_CONFLICT);
};