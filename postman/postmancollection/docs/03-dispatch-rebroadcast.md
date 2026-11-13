# Dispatch Re-broadcast & Outbox Playbook

## Mode flag

```
DISPATCH_REBROADCAST_MODE=notify_new
```

- Unset or any other value → `legacy`.
- `notify_new` enables the “notify only new/expired offers” behavior.
- The flag is read per match call. Changing it requires a process restart.

## Legacy vs notify_new

| Behavior | `legacy` | `notify_new` |
| --- | --- | --- |
| Every re-broadcast cycle | Re-notifies all eligible technicians | Notifies only new/expired offers |
| Live offer | Version increment + `job:new` + push | Extends `expiresAt`; no version bump, no outbox, no push |
| Declined/rejected technician | Skipped by status guards | Excluded from candidate selection |
| Feed refresh | `technician:jobs_changed` for all | `technician:jobs_changed` for active candidates |
| Decline of last live offer | Waits for the 10-minute cron | Immediate best-effort rematch, cron fallback |

Both modes keep the existing transactional matching, version fencing,
eligibility checks, and acceptance concurrency protections.

## Scheduled dispatch

Scheduled bookings use the same outbox and version fencing, but the first
dispatch is delayed:

- `dispatchEligibleAt = scheduledAt - SCHEDULED_DISPATCH_LEAD_HOURS` (default
  24h), clamped to `now` if already past.
- `autoCancelAt = scheduledAt - 5h` (or `now + 5m` if already past).
- Candidate selection uses `serviceBaseLocation` as the travel origin, checks
  the scheduled job chain for feasibility, and enforces active/daily caps and
  `notificationPreferences.scheduledOffersEnabled`.
- `SCHEDULED_CANDIDATE_CAP` (default 20) caps scheduled candidates per match.
- Offline technicians can receive scheduled offers through FCM/outbox; live
  `job:new` is emitted only when a socket is connected.
- Quiet hours defer scheduled pushes to the next business-hour boundary unless
  the deferral would pass `autoCancelAt`, in which case the push is sent
  immediately. Push cooldown is `SCHEDULED_PUSH_COOLDOWN_MINUTES` (default
  180).
- Rescheduling expires current offers/outbox rows and recomputes
  `dispatchEligibleAt` / `autoCancelAt`.
- If the technician has not started travel, the scheduled enforcement cron can
  release the assignment (`schedule_travel_no_show`), expire broadcasts, and
  re-match within `SCHEDULED_REDISPATCH_WINDOW_MINUTES` (default 30).

## Outbox behavior

Each dispatched `job:new` is represented by a `DispatchOutbox` row keyed by
booking, technician, kind, and broadcast version.

On a transactional re-broadcast:

1. Live `pending`/`inflight` rows for that booking + technician set are closed
   (`status: "done"`, `lastError: "superseded_by_rebroadcast"`).
2. Current-version rows are inserted with `$setOnInsert`.
3. Rows for technicians no longer in the active offer set are closed as
   superseded.
4. The worker wakes up and delivers `job:new`; delivery is at-least-once.

The partial unique index prevents two live rows for the same
booking + technician + kind. Admin retry returns `409` if a live duplicate
already exists.

## Decline flow (`notify_new`)

1. The decline is committed in a short transaction with version and status
   guards.
2. The broadcast row becomes `rejected`; the offer row becomes `declined`
   with `rejectReason` and `responseLatencyMs`.
3. If no unexpired `sent` broadcast remains for the booking, an immediate
   rematch is fired without blocking the HTTP response.
4. If the process dies before the rematch commits, the 10-minute cron retries.

## Cron behavior

- Re-broadcast cron only updates `lastRebroadcastAt` when the matcher returns
  `BROADCASTED`. A run with no eligible technicians does not suppress the next
  attempt.
- Offer expiry and feed removal continue to use the normal booking crons.

## Admin operations

| Action | Endpoint |
| --- | --- |
| Inspect queue | `GET /api/admin/dispatch/stats` |
| Inspect failures | `GET /api/admin/dispatch/failed` |
| Inspect pending/inflight | `GET /api/admin/dispatch/pending?status=all` |
| Retry one row | `POST /api/admin/dispatch/:id/retry` |
| Retry all failures | `POST /api/admin/dispatch/retry-failed` |
| Restart worker | `POST /api/admin/dispatch/worker/restart` |
| Stop worker (maintenance) | `POST /api/admin/dispatch/worker/stop` |

## Staging verification checklist

1. Deploy with the flag unset; confirm existing behavior is unchanged.
2. Set `DISPATCH_REBROADCAST_MODE=notify_new` and restart.
3. Create a booking and connect one technician socket.
4. Confirm `job:new` arrives once; note `broadcastId` and `version`.
5. Wait for a re-broadcast cycle:
   - No second `job:new` for the live offer.
   - `technician:jobs_changed` is emitted.
   - `GET /job-broadcast/my-jobs` shows the extended `expiresAt`.
6. Decline the only live offer:
   - Offer row is `declined` with a reason.
   - If no live offers remain, a rematch starts immediately.
   - A different eligible technician receives `job:new` once.
7. Force a stale/failed outbox row and confirm admin retry works without
   creating a duplicate live row.
8. Check `GET /api/admin/dispatch/stats` for failed/stale-inflight growth.

## Rollback

Unset `DISPATCH_REBROADCAST_MODE` and restart. No schema change is required;
existing `TechnicianBookingOffer` rows with `decision: "rejected"` remain
readable.
