// Centralized location/staleness configuration
// Single source of truth for all GPS freshness thresholds

export const STALENESS_SECONDS = (() => {
  const raw = Number(process.env.LOCATION_STALENESS_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
})();

export const ACCEPT_GRACE_SECONDS = 15 * 60; // 15 minutes for accept

export const STALENESS_CUTOFF = () => new Date(Date.now() - STALENESS_SECONDS * 1000);
export const stalenessCutoff = STALENESS_CUTOFF; // camelCase alias

export const ACCEPT_STALENESS_CUTOFF = () => new Date(Date.now() - ACCEPT_GRACE_SECONDS * 1000);

// GPS freshness check with mode-specific threshold
// mode: "BROADCAST" = 90s, "ACCEPT" = 15min (900s), "FETCH" = 90s
export function checkGpsFreshness(tech, mode = "BROADCAST") {
  if (STALENESS_SECONDS <= 0) return true;
  if (!tech?.locationUpdatedAt) return false;
  
  const threshold = mode === "ACCEPT" ? ACCEPT_GRACE_SECONDS : STALENESS_SECONDS;
  const cutoff = new Date(Date.now() - threshold * 1000);
  return new Date(tech.locationUpdatedAt) >= cutoff;
}

// GPS validity check
export function checkGpsValid(tech) {
  const coords = tech?.location?.coordinates;
  return Array.isArray(coords) && coords.length === 2 &&
    Number.isFinite(coords[0]) && Number.isFinite(coords[1]) &&
    coords[1] >= -90 && coords[1] <= 90 &&
    coords[0] >= -180 && coords[0] <= 180;
}

export function checkGpsStale(tech, mode = "BROADCAST") {
  return !checkGpsFreshness(tech, mode);
}

/**
 * Structured GPS state used by eligibility diagnostics. Keeps the canonical
 * 90s (BROADCAST/FETCH) and 15m (ACCEPT) thresholds while exposing WHY a
 * technician failed so operators can distinguish missing fix / missing
 * timestamp / stale fix / malformed coordinates.
 */
export function getGpsState(tech, mode = "BROADCAST") {
  const thresholdSeconds =
    mode === "ACCEPT" ? ACCEPT_GRACE_SECONDS : STALENESS_SECONDS;
  const valid = checkGpsValid(tech);
  const hasTimestamp = Boolean(tech?.locationUpdatedAt);
  const timestampMs = hasTimestamp ? new Date(tech.locationUpdatedAt).getTime() : null;
  const validTimestamp = Number.isFinite(timestampMs);
  const ageMs = validTimestamp ? Math.max(0, Date.now() - timestampMs) : null;
  const fresh =
    thresholdSeconds <= 0 || (ageMs != null && ageMs <= thresholdSeconds * 1000);

  let reason = null;
  if (!valid) reason = "MISSING_LOCATION";
  else if (!hasTimestamp || !validTimestamp) reason = "GPS_TIMESTAMP_MISSING";
  else if (!fresh) reason = "GPS_STALE";

  return {
    valid,
    fresh,
    hasTimestamp: hasTimestamp && validTimestamp,
    ageMs,
    ageSeconds: ageMs != null ? Math.round(ageMs / 1000) : null,
    thresholdSeconds,
    reason,
  };
}