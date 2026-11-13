# Socket.IO Connection & Notifications

The server uses **Socket.IO v4** (not raw WebSocket). Postman can probe the HTTP
handshake, but it cannot speak the Socket.IO protocol; use a Socket.IO client
for real event testing.

For the consolidated scheduling lifecycle, per-role socket matrix, and endpoint
map, see `docs/06-scheduling-flow-sockets-endpoints.md`.

## Connecting

```js
import { io } from "socket.io-client";

const socket = io(process.env.BASE_URL, {
  transports: ["websocket", "polling"],
  auth: {
    token: technicianJwt, // required
  },
});
```

Rules enforced by the server:

- The JWT must be sent in `handshake.auth.token`. Query-string tokens are
  ignored because URLs leak into logs and browser history.
- Deleted, blocked, or suspended accounts are rejected during the handshake.
- The JWT's `tokenVersion` must match the database. A password/role change or
  an explicit revocation kills existing sockets.
- For technicians, the profile is resolved from the authenticated user id. A
  token that claims another technician's profile id is rejected.
- One user gets one active socket. A new connection emits `session:replaced`
  to the old socket and disconnects it.
- Handshake rate limit: 20 attempts per 60 seconds per client.
- Payload limit: 500 KB.
- Short disconnects (up to 2 minutes) can recover and replay missed events.

## Rooms

Rooms are joined automatically after authentication; clients never join rooms
manually.

| Room | Members |
| --- | --- |
| `user:<userId>` | The authenticated user |
| `role:<role>` | All users with that role |
| `technician_<technicianProfileId>` | Technician operational room |
| `customer_<customerId>` | Backward-compatible customer room |
| `admin_dashboard`, `admin_room`, `admin` | Admin/Owner dashboard rooms |

Technician sockets intentionally join **both** `technician_<profileId>` and
`user:<userId>`. Server helpers union those rooms so a single socket receives
an event once.

## Client → server events

### `technician:location_update`

Payload:

```json
{ "latitude": 12.9716, "longitude": 77.5946 }
```

Acknowledgment:

```json
{ "success": true, "locationUpdated": true, "matchCalculation": true, "jobsFound": 2 }
```

Possible failures: `INVALID_COORDINATES`, throttled
(`retryAfterMs: 5000`), or unauthorized. Technicians only.

### `technician:get_jobs`

Payload (optional cursor):

```json
{ "since": 1730000000000 }
```

Acknowledgment:

```json
{ "success": true, "unchanged": false, "count": 2, "latestVersion": 1730000001000 }
```

If `since >= latestVersion`, the server returns `unchanged: true` without a
heavy query. The client should call this after `technician:jobs_changed`, on
connect, or when returning to the foreground; there is no need to poll faster
than the 3-second per-socket limit.

## Server → technician events

| Event | When | Key payload |
| --- | --- | --- |
| `job:new` | A new offer is delivered | `bookingId`, `broadcastId`, `version`, `scheduledAt`, service/address/distance fields |
| `booking:backup_offer` | A late-completion backup offer is delivered | `{ bookingId, message, type: "BACKUP_OFFER", slotKey, slotLabel }` |
| `booking:backup_replaced` | A backup took over this technician's late-running job | `{ bookingId, message }` |
| `technician:jobs_list` | Response to `technician:get_jobs` | Array of job DTOs |
| `technician:jobs_changed` | Feed changed (new/expired/keep-live extension) | `{ changed: true, at }` |
| `jobs_changed` | Legacy flat feed event | `{ action, bookingId, broadcastId, reasons, at }` |
| `job:expired` | The offer expired or was revoked | `{ bookingId, broadcastId, expiresAt, reason, reasons }` |
| `job_taken` | Another technician accepted the job | `{ bookingId, message, timestamp }` |
| `job_cancelled_by_customer` | Assigned customer cancelled the booking | `{ bookingId, message, type: "BOOKING_CANCELLED" }` |
| `technician:location_required` | GPS is missing/stale for broadcasting | `{ code, reason, ageSeconds, thresholdSeconds }` |
| `technician:offline` | Presence sweeper marked the technician offline | `{ code, reason, at }` |
| `booking:reminder` | Scheduled-job reminder | `{ type: "h24" \| "h1" \| "min15", bookingId, scheduledAt, message }` |
| `booking:travel_reminder` | 35-minute start-travel CTA | `{ bookingId, message, type: "START_TRAVEL_CTA" }` |
| `booking:travel_escalation` | Travel not started; escalation | `{ bookingId, message, type: "START_TRAVEL_URGENT" }` |
| `customer_no_show_response` | Customer says they are available | `{ bookingId, available: true, message }` |
| `customer_no_show_confirmed` | No-show claim confirmed | `{ bookingId, compensationStatus }` |
| `payment_received` | Customer payment succeeded | `{ bookingId, amount, status }` |
| `auto_payout_paid` | Manual payout marked paid (legacy event name) | `{ withdrawalId, netPayoutAmountPaise, utr, payoutMode }` |
| `notification:new` | In-app notification row created | `{ type, title, message, bookingId, createdAt }` |
| `permission_status_changed` | Admin changed permissions | Permission snapshot |
| `session:replaced` | Same account connected elsewhere | `{ message }` |
| `session:revoked` | Technician account status/token revoked | `{ reason }` |

`job:new` sample:

```json
{
  "bookingId": "665f...",
  "broadcastId": "6660...",
  "version": 3,
  "serviceId": "6640...",
  "serviceName": "AC Repair",
  "serviceType": "General",
  "description": "Not cooling",
  "duration": "60",
  "customerName": "Asha",
  "baseAmount": 499,
  "address": "12 MG Road",
  "scheduledAt": "2026-10-29T10:00:00.000Z",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "distanceMeters": 3200,
  "distanceKm": 3.2,
  "distanceStr": "3.2 km",
  "jobRadiusKm": 10,
  "maxRadiusKm": 10,
  "maxAllowedMeters": 10000
}
```

### Scheduled-booking sequence

Scheduled offers use the same `job:new` event as instant offers. The payload
does **not** include a `bookingType` field; a non-null `scheduledAt` identifies
a scheduled offer. Scheduled dispatch starts immediately;
`dispatchEligibleAt` is `null`/now.

| Stage | Events |
| --- | --- |
| Booking created | admin `new_booking`; `notification:new` when a notification row is created |
| Offer delivered | technician `job:new`, `technician:jobs_changed`, legacy `jobs_changed`, `notification:new` |
| Backup offer | backup technician `booking:backup_offer` + feed refresh |
| Offer expired/revoked | technician `job:expired`, `jobs_changed` with `action: "removed"` |
| Another technician wins | other technicians `job_taken` |
| Accepted | customer `booking:accepted` + legacy `job_accepted`; technician feed refresh |
| Backup takeover | backup gets promoted; original technician `booking:backup_replaced`; customer `booking:accepted` with the new technician |
| Reminders | technician `booking:reminder` (`h24`, `h1`, `min15`) |
| Travel enforcement | technician `booking:travel_reminder` / `booking:travel_escalation` |
| Rescheduled | customer room + `admin_dashboard`: `booking_rescheduled` |
| Customer cancelled | assigned technician: `job_cancelled_by_customer`; customer gets the HTTP response and normal notification flow |
| Technician cancelled (future slot) | customer `booking:rebroadcast`; booking is re-matched |
| Customer no-show | customer `customer_no_show_reported`; technician `customer_no_show_response` or `customer_no_show_confirmed` |
| Late-completion at-risk | admin `booking_at_risk`; backup search may run |
| Completed | customer `booking:completed`; payment events follow |

Offline scheduled technicians receive FCM/outbox delivery instead of a live
`job:new`. Acceptance still requires online presence. See
`docs/04-scheduled-booking-and-technician-jobs.md` for the full lifecycle and
Postman run order.

### Delivery semantics

- `job:new` is deduplicated server-side by
  `broadcastId + technicianId + version`, and the outbox uses the same key.
  Clients should still render by `bookingId` and ignore a repeated
  `broadcastId/version`.
- A re-broadcast under `DISPATCH_REBROADCAST_MODE=notify_new` sends `job:new`
  only to technicians with a new or expired offer. Technicians with a live
  offer get only an extended expiry and a `technician:jobs_changed` refresh
  event — no duplicate `job:new` or push.
- Feed events are best-effort. REST (`GET /job-broadcast/my-jobs`) remains the
  source of truth after reconnect.
- `notification:new` is for the notification tray; it is not a job offer.

## Server → customer events

| Event | When |
| --- | --- |
| `booking:accepted` / `job_accepted` | A technician accepted the booking |
| `booking:completed` | Service completed and verified |
| `booking:cancelled` | Booking cancelled (standardized notification event) |
| `booking_cancelled` | Raw underscore event used by cron/technician-cancel paths |
| `booking:rebroadcast` | Assigned technician cancelled while the slot is still future; the booking is being re-matched |
| `booking_rescheduled` | Scheduled booking moved to a new slot (raw event; not in `SOCKET_EVENTS`) |
| `customer_no_show_reported` | Technician reported the customer unavailable; 10-minute response window |
| `payment_due` | Completion OTP requested; payment is now due |
| `payment_success` | Payment confirmed |
| `payment:status` | Async payment status update |
| `notification:new` | In-app notification row created |
| `refund:initiated`, `refund:processed` | Refund lifecycle events |
| `session:replaced` | Same account connected elsewhere |

## Server → admin events

| Event | When |
| --- | --- |
| `new_booking` | A booking was created |
| `admin:unread_counts_updated` | Admin notification counts changed |
| `booking_at_risk` | Scheduled travel risk or late completion without a backup (`SCHEDULED_AT_RISK`, `LATE_COMPLETION_NO_BACKUP`) |
| `payment_success` | Payment confirmed |
| `booking:payment_overdue` | Completed booking still unpaid |
| `withdrawal:requested` | Technician requested a payout |
| `refund:manual_review`, `complaint:sla_breach` | Ops attention required |

## Manual payout events

Automatic payout execution is permanently disabled. Payouts are manual: a
technician requests a withdrawal, an admin approves it, transfers offline, then
records the UTR.

### Current implementation

| Role | Event | Trigger | Notes |
| --- | --- | --- | --- |
| Admin | `withdrawal:requested` | Technician submits a withdrawal request | Emitted to `admin_dashboard`; no persistent admin notification row is created today |
| Technician | `auto_payout_paid` | Admin records the bank UTR via mark-paid | Legacy event name retained for client compatibility; emitted to `technician_<profileId>` |
| Technician | — | Request rejected | In-app `WITHDRAWAL_REJECTED` row is written, but no socket event is emitted |
| Technician | — | Paid payout reverted | In-app `WITHDRAWAL_FAILED` row is written, but no socket event is emitted |
| Technician | — | Payout frozen/unfrozen | No socket or notification today |
| Customer | — | Payouts | Customers are not involved in technician payouts |

`notification:new` is guaranteed only for flows that use the unified
notification service. The payout code currently uses direct
`Notification.create()` calls plus a manual `auto_payout_paid` emit, so clients
must not assume `notification:new` for every payout update.

### Recommended contract

If backend parity is added later, use these event names and route them through
the unified notification service:

| Event | Recipient | Trigger |
| --- | --- | --- |
| `withdrawal:requested` | Admin dashboard | Technician request created |
| `withdrawal:approval_required` | Admin dashboard | High-value admin_direct payout needs a second admin |
| `withdrawal:approved` | Technician | Admin approves a request |
| `withdrawal:rejected` | Technician | Admin rejects a request |
| `withdrawal:paid` | Technician | Admin records UTR (keep `auto_payout_paid` as an alias) |
| `withdrawal:failed` | Technician + Admin | Paid payout reverted or bank return |
| `payout:frozen` / `payout:unfrozen` | Technician | Risk/Legal hold changes |

Recommended persistent notification event types: `WITHDRAWAL_REQUESTED`,
`WITHDRAWAL_APPROVAL_REQUIRED`, `WITHDRAWAL_APPROVED`, `WITHDRAWAL_REJECTED`,
`WITHDRAWAL_PAID`, `WITHDRAWAL_FAILED`, `PAYOUT_FROZEN`, `PAYOUT_UNFROZEN`.

See `docs/05-manual-payouts.md` for the full payout flow and Postman run order.

## Minimal client flow

```js
socket.on("connect", () => {
  socket.emit("technician:get_jobs", {}, (ack) => {
    if (ack?.success) renderJobs(ack);
  });
});

socket.on("technician:jobs_changed", () => {
  socket.emit("technician:get_jobs", { since: lastVersion }, (ack) => {
    if (ack?.success && !ack.unchanged) renderJobs(ack);
    lastVersion = ack?.latestVersion ?? lastVersion;
  });
});

socket.on("job:new", (job) => upsertJob(job));

socket.on("job:expired", ({ bookingId }) => removeJob(bookingId));

socket.on("session:replaced", () => {
  // Stop reconnecting with the same session; the other device owns it.
});

socket.on("session:revoked", () => {
  // Force logout and re-authenticate through REST.
});
```

## Manual probe from Postman

The collection includes an Engine.IO handshake probe:

```
GET {{baseUrl}}/socket.io/?EIO=4&transport=polling&t={{$timestamp}}
```

A `200` response beginning with `0` proves the Socket.IO endpoint is reachable.
It does **not** authenticate the socket; use a Socket.IO client with
`auth.token` for event-level testing.
