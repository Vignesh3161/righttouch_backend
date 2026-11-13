# Scheduled Booking & Technician Job Handling

This guide covers the scheduled-booking lifecycle end to end: slot discovery,
booking creation, immediate scheduled dispatch, technician base locations, offer
accept/decline, travel/arrival/start, reminders, rescheduling, cancellation,
and the Socket.IO events emitted at each stage.

Use it with:

- `collections/righttouch_scheduled_booking_and_technician_jobs.postman_collection.json`
- `environments/righttouch_dispatch_and_socket.postman_environment.json`
- `docs/01-http-endpoints.md` for the full HTTP index
- `docs/02-socket-notifications.md` for connection/room rules

## Lifecycle at a glance

```
slots -> create scheduled booking (pending)
      -> dispatch immediately
      -> broadcast offers (job:new) to eligible technicians
      -> accept (accepted) or decline/expire
      -> reminders (24h / 1h / 15m / enforce-on-the-way)
      -> on_the_way -> reached -> in_progress
      -> payment + completion OTP -> completed
```

Failure branches:

- No technician accepts: offers expire, the booking can auto-cancel at
  `autoCancelAt`, and the customer is notified.
- Customer reschedules before assignment: old offers are expired and the
  booking is re-dispatched for the new slot.
- Customer cancels: pending offers expire; the assigned technician receives
  `job_cancelled_by_customer`.
- Technician cancels while the slot is still in the future: the booking is
  re-broadcast and the customer receives `booking:rebroadcast`.
- Technician has not started travel near the slot: reminders escalate and the
  job can be released and re-broadcast (`schedule_travel_no_show`).


## Current four-slot contract (authoritative)

- Bookable window: **5 days** (tomorrow + the next 4 days).
- Slots per day: **four 3-hour slots** — `09:00–12:00`, `12:00–15:00`,
  `15:00–18:00`, `18:00–21:00` in the business timezone.
- A technician can hold **one scheduled job per slot**. Accepting a scheduled
  job blocks that whole slot for both instant and scheduled offers. Finishing
  early re-enables instant work immediately; other-slot scheduled jobs remain
  visible.
- Scheduled dispatch is **immediate**; `dispatchEligibleAt` is `null`/now.
  `SCHEDULED_DISPATCH_LEAD_HOURS` must be `0`.
- A scheduled booking stays `pending` and displays **"Awaiting technician"**
  until a technician accepts. It is not customer-confirmed.
- `on_the_way` is allowed from **slot start − 35 minutes**; `in_progress` is
  allowed only at/after slot start.
- Service duration plus 30 minutes of travel must fit in 180 minutes
  (maximum 150-minute service) for scheduled bookings.
- Max 2 reschedules per booking; cancellation/reschedule fees remain audit
  only until the customer wallet exists.
- Cart checkout rejects multiple items booked into the same slot with
  `MULTI_ITEM_SAME_SLOT_NOT_SUPPORTED`.
- Slot contention returns `SLOT_BUSY`; no supply returns
  `NO_ELIGIBLE_TECHNICIAN`.

## Late completion and backup

When a scheduled job is projected to finish too late for the technician's
next slot, the platform keeps the original technician assigned and offers a
backup for the current slot. The original is released only after a backup
accepts. If no backup accepts by slot start − 15 minutes, the original keeps
the job and the customer is told about the delay. Backup offers appear in the
normal technician job feed with `isBackupOffer: true`.

## Customer no-show

Technician flow: mark `reached`, place a masked call with
`POST /api/technician/booking/:id/masked-call`, wait 15 minutes, then
`POST /api/technician/booking/:id/customer-no-show` with `{ callLogId }`.
The `callLogId` must belong to a backend-created call log for the same
booking/technician; fabricated IDs are rejected. The technician must be within
`NO_SHOW_GEOFENCE_METERS` (default 100m).

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MASKED_NUMBER`, and
`PUBLIC_BASE_URL` for real masked calls. In non-production,
`ALLOW_MANUAL_CALL_LOGS=true` permits manual call logs when Twilio is absent.

Customer flow: `POST /api/user/booking/:id/customer-no-show/respond` with
`{ available: true | false }` within 10 minutes. No response auto-confirms the
claim. Compensation is recorded as a claim/liability only when
`CUSTOMER_NO_SHOW_COMPENSATION_ENABLED=true`; no automatic payout is made.
Three reports in 30 days flag the technician for reliability review.

Admin review uses
`PUT /api/user/booking/:id/customer-no-show/compensation` with
`{ action: "approve" | "reject" | "mark_paid", note?, providerReference? }`.
Approval posts a `manual_adjustment` debit ledger entry with status `pending`;
`mark_paid` flips it to `posted`. No automatic bank payout is performed.

## 1. Slot discovery

```http
GET /api/user/booking/slots?serviceId=<id>&latitude=12.9716&longitude=77.5946
```

Alternative for a saved address (requires the customer bearer token):

```http
GET /api/user/booking/slots?serviceId=<id>&addressId=<id>
```

Rules:

- Bookable days are **tomorrow plus the next four days** (five days total) in
  `BUSINESS_TIMEZONE` (default `Asia/Kolkata`).
- Slots are four 3-hour windows: **09:00–12:00, 12:00–15:00, 15:00–18:00,
  18:00–21:00**.
- `scheduledDate` must be `YYYY-MM-DD` and `scheduledTime` must be the slot
  start value (`09:00`, `12:00`, `15:00`, or `18:00`), exactly as returned by
  this endpoint.
- `addressId` is used only when latitude/longitude are absent. It must belong
  to the authenticated customer.
- `availability` is indicative supply for the five days. It is cached for 30
  seconds and is intentionally soft: zero supply is surfaced, but booking is
  not blocked unless `BLOCK_BOOKING_WHEN_NO_SUPPLY=true` (currently not
  enforced by the booking endpoint).

Response shape (abridged):

```json
{
  "success": true,
  "result": {
    "instant": {
      "label": "Instant",
      "displayValue": "In 30 mins",
      "estimatedArrivalAt": "2026-11-03T10:30:00.000Z",
      "note": "Estimated arrival — not a guaranteed SLA"
    },
    "schedule": {
      "days": [
        { "date": 4, "month": "Nov", "fullDate": "2026-11-04", "dayName": "Wed", "weekday": "Wed" }
      ],
      "timeSlots": [
        { "label": "09:00 AM - 12:00 PM", "value": "09:00" },
        { "label": "12:00 PM - 03:00 PM", "value": "12:00" },
        { "label": "03:00 PM - 06:00 PM", "value": "15:00" },
        { "label": "06:00 PM - 09:00 PM", "value": "18:00" }
      ],
      "timezone": "Asia/Kolkata",
      "availability": {
        "enabled": true,
        "available": true,
        "technicianCount": 4,
        "totalAvailableSlots": 18,
        "blocking": false,
        "limitedThreshold": 3,
        "days": {
          "2026-11-04": {
            "09:00": { "technicianCount": 2, "availability": "LIMITED" },
            "15:00": { "technicianCount": 4, "availability": "AVAILABLE" }
          }
        }
      }
    }
  }
}
```

The Postman collection captures the first available day/slot into
`scheduledDate` / `scheduledTime`, and a second slot into
`rescheduleDate` / `rescheduleTime`.

## 2. Create a scheduled booking

```http
POST /api/user/booking/schedule
Authorization: Bearer <customer>
Content-Type: application/json
```

```json
{
  "serviceId": "<active-service-id>",
  "bookingType": "scheduled",
  "scheduledDate": "2026-11-04",
  "scheduledTime": "10:00",
  "locationType": "gps",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "faultProblem": "Not cooling"
}
```

For a saved address, send `"locationType": "saved"` and `"addressId": "<id>"`
instead of GPS coordinates. `addressId` takes precedence when present.

Response:

```json
{
  "success": true,
  "message": "Booking scheduled for 04 Nov 2026, 10:00 am. We're finding you a technician now.",
  "result": {
    "bookingId": "665f...",
    "bookingType": "scheduled",
    "status": "pending",
    "scheduledAt": "2026-11-04T04:30:00.000Z",
    "scheduledDateLocal": "2026-11-04",
    "scheduledTimeLocal": "10:00",
    "timezone": "Asia/Kolkata",
    "broadcastCount": 0
  }
}
```

Internally the booking is stored with `bookingType: "schedule"`; the create
response returns the client-facing value `"scheduled"`.

Server-side scheduling fields:

| Field | Meaning |
| --- | --- |
| `scheduledAt` | UTC instant built from the business-timezone wall clock |
| `dispatchEligibleAt` | `null`/now; scheduled dispatch starts immediately |
| `autoCancelAt` | `scheduledAt - 5h`; if already past, `now + 5m` |
| `estimatedDurationMinutes` | Snapshot of `Service.durationMinutes` (default 60) |

Matching starts immediately after creation. The booking stays `pending` only
until a technician accepts; it does not wait for a dispatch lead time.

### Dispatch eligibility

A technician is considered for a scheduled offer only when all of these hold:

- `workStatus=approved`, `profileComplete=true`, `trainingCompleted=true`
- KYC approved and bank verified
- the service is in the technician's skills
- district/zone permissions match
- `notificationPreferences.scheduledOffersEnabled !== false`
- the technician is inside the service radius, measured from
  `serviceBaseLocation` (fallback: live `location`)
- active-job and daily scheduled caps allow another offer
- the scheduled job chain is feasible (travel time + buffer + existing jobs)

Scheduled offers may be delivered to offline technicians through FCM and the
outbox. **Accepting always requires online presence.** Instant offers still
require online presence for feed delivery.

## 3. Technician base location

Scheduled matching uses a stable base location, not the technician's live GPS.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/technician/service-base-location/me` | Technician | Read own base location |
| PUT | `/api/technician/service-base-location/me` | Technician | Set own base location |
| GET | `/api/technician/admin/service-base-location/missing?page=1&limit=50` | Admin/Owner | Review technicians needing a base location |
| GET | `/api/technician/admin/technicians/:technicianId/service-base-location` | Admin/Owner | Read one technician |
| PUT | `/api/technician/admin/technicians/:technicianId/service-base-location` | Admin/Owner | Set/verify one technician |

Self update:

```json
{ "latitude": 12.9716, "longitude": 77.5946 }
```

Admin update:

```json
{
  "latitude": 12.9716,
  "longitude": 77.5946,
  "verified": true,
  "force": false,
  "reason": "Verified home base"
}
```

- Coordinates are validated for blank values and range.
- The server resolves district/zone. A district outside the technician's
  allowed districts is rejected unless an admin sends `force=true`.
- Self updates are stored with `source=self` and `verified=false`.
- Admin updates are stored with `source=admin`; `verified` is honored.
- The response includes `fallbackLocation` (live GPS), allowed district ids,
  and allowed zone ids.
- Sources: `registration`, `admin`, `self`, `last_known`, `backfill`.

`scripts/backfillServiceBaseLocation.js` can copy a valid live `location`
into `serviceBaseLocation` with `source=last_known`; run it in dry-run mode
first.

## 4. Offer feed and job handling

### Feed

```http
GET /api/technician/job-broadcast/my-jobs
Authorization: Bearer <technician>
```

Each offer includes `bookingId`, `broadcastId`, `version`, service/address
details, distance fields, and `scheduledAt`. A non-null `scheduledAt`
identifies a scheduled offer; `job:new` does not carry a separate
`bookingType` field.

The feed is a snapshot. `technician:jobs_changed` means “refetch”; the socket
event is not the source of truth.

### Accept / decline

```http
PUT /api/technician/job-broadcast/respond/:bookingId
```

Accept:

```json
{ "action": "accepted", "version": 3 }
```

Decline:

```json
{ "action": "declined", "version": 3, "reason": "not_available" }
```

`version` must be the number from the feed/`job:new` payload. The server also
accepts the legacy aliases (`accept`, `agree`, `yes`, `decline`, `reject`,
`no`), but clients should use `accepted` / `declined`.

Accept guards:

- technician must be online
- activation/KYC must still be valid
- offer must still be `sent` and unexpired
- version must match
- technician must not already have a conflicting active instant job
- scheduled chain must remain feasible
- atomic claim must win

Common failures:

| Status | Reason |
| --- | --- |
| `403` | Not assigned to this technician, not eligible, or offline |
| `409` | Version mismatch, taken, concurrent claim, or conflicting job |
| `410` | Offer expired; refresh the feed |

Declining suppresses immediate re-offer for
`REOFFER_DECLINED_AFTER_MINUTES` (default 0). Declining the last live offer can
trigger an immediate rematch; the 10-minute cron remains the fallback.

### Status updates

```http
PUT /api/technician/status/:bookingId
```

```json
{ "status": "on_the_way" }
```

Allowed values: `on_the_way`, `reached`, `in_progress`, `completed`.
Completion is not accepted through this route without the payment/OTP flow;
use the completion endpoints below.

### Completion and payment

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/technician/booking/:id/completion-otp` | Returns `paymentRequired=true` until paid |
| POST | `/api/technician/booking/:id/completion-otp/resend` | Rotates/sends after payment |
| POST | `/api/technician/booking/:id/verify-completion-otp` | Requires `paymentStatus=paid` |
| GET | `/api/technician/booking/:id/completion-status` | Safe status read |

### Technician cancellation and re-acceptance

```http
PUT /api/technician/booking/technician/cancel/:bookingId
{ "reason": "technician_unavailable" }
```

- Cancellable states: `accepted`, `on_the_way`, `reached`, `in_progress`.
- A configurable penalty (`TECHNICIAN_CANCEL_PENALTY_PAISE`, default ₹200) is
  recorded on the technician wallet.
- The cancelling technician's broadcast is marked `rejected`, so the same job
  is not immediately re-offered to them.
- If the scheduled slot is still in the future, the booking is re-broadcast to
  find a replacement and the customer receives `booking:rebroadcast`.

```http
PUT /api/technician/booking/reaccept/:bookingId
```

- Only a cancelled job assigned to this technician can be re-accepted.
- The same one-active-job guard applies.
- The admin-configured reaccept penalty percent is applied server-side;
  client-supplied penalty flags are ignored.

### Upcoming schedules

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/technician/jobs/current` | Current active jobs |
| GET | `/api/technician/jobs/accepted` | Accepted jobs, newest first |
| GET | `/api/technician/jobs/accepted/scheduled` | Accepted scheduled jobs only |
| GET | `/api/technician/jobs/history` | Technician history |

`/jobs/accepted` and `/jobs/accepted/scheduled` return `result` as an array
with `jobId`, `bookingType`, `status`, customer/technician/service/address
summaries, `scheduledAt`, and pagination metadata.

## 5. Reschedule

```http
PUT /api/user/booking/reschedule/:id
Authorization: Bearer <customer>
```

```json
{
  "scheduledDate": "2026-11-05",
  "scheduledTime": "15:30",
  "reason": "Plan changed"
}
```

Rules:

- Only `bookingType=schedule` bookings with `scheduledAt`.
- Only unassigned bookings in `pending` / `broadcasted`.
- The new slot must differ from the current slot.
- Rescheduling closes `RESCHEDULE_CUTOFF_MINUTES` (default 300) before the
  appointment; inside that window the customer must cancel and rebook.
- The new slot is validated with the same slot engine used at creation.
- `autoCancelAt` is recomputed; `dispatchEligibleAt` remains `null`/now.
- Existing broadcasts/offers are expired and the booking is re-dispatched.
- Emits `booking_rescheduled` to `customer_<customerId>` and
  `admin_dashboard` with `bookingId`, `scheduledAt`,
  `scheduledDateLocal`, `scheduledTimeLocal`, and `timezone`.

## 6. Customer cancellation

```http
PUT /api/user/booking/cancel/:id
Authorization: Bearer <customer>
```

```json
{ "reason": "No longer needed" }
```

Scheduled cancellation fees:

| Timing | Fee |
| --- | --- |
| More than 3 hours before the slot | Free |
| 2–3 hours before | ₹50 |
| Less than 2 hours before | ₹100 |
| Technician already `reached` | ₹120 |
| Technician late by >15 minutes | Free |

Instant cancellation: free while pending; ₹50 once accepted/on the way; ₹120
at the door. Recorded fees are currently audit-only (`not_collected`) because
there is no customer wallet deduction yet.

Effects:

- pending offers are expired
- assignment history is released
- the assigned technician receives `job_cancelled_by_customer`
- the customer receives the HTTP response and the normal notification flow
- a cron-driven no-technician cancellation can also emit the raw
  `booking_cancelled` event to the customer room

## 7. Socket.IO notification sequence

Connection rules, rooms, authentication, and the complete event registry are
in `docs/02-socket-notifications.md`. The scheduled-booking-specific sequence
is below.

### Created / dispatched

| Event | Room | Key payload | Notes |
| --- | --- | --- | --- |
| `new_booking` | `admin_dashboard` | `bookingId`, `status`, `scheduledAt`, `baseAmount` | Admin dashboard feed |
| `job:new` | technician rooms | `bookingId`, `broadcastId`, `version`, `scheduledAt`, distance fields | Scheduled offers have non-null `scheduledAt`; no `bookingType` field |
| `technician:jobs_changed` | technician rooms | `{ changed: true, at }` | Refetch the feed |
| `jobs_changed` | technician rooms | `{ action, bookingId, broadcastId, reasons, at }` | Legacy flat refresh event |
| `notification:new` | user room | `type`, `title`, `message`, `bookingId`, `createdAt` | Notification tray |
| `job:expired` | technician rooms | `bookingId`, `broadcastId`, `expiresAt`, `reason`, `reasons` | Offer expired/revoked |
| `job_taken` | other technicians | `bookingId`, `message`, `timestamp` | Another technician won |

Offline scheduled technicians receive FCM/outbox delivery instead of a live
`job:new`. The same dedupe key (`broadcastId + technicianId + version`) is
used by the socket and outbox paths.

### Accepted

| Event | Room | Key payload |
| --- | --- | --- |
| `booking:accepted` | customer rooms | `bookingId`, `technicianId`, `status`, `technicianName`, `timestamp` |
| `job_accepted` | customer rooms (legacy) | Same payload |
| `notification:new` | customer user room | `type: BOOKING_ACCEPTED`, title/message, `bookingId` |
| `technician:jobs_changed` / `jobs_changed` | technician feed | Feed refresh for offer removal |

### Reminders

| Event | Room | Key payload |
| --- | --- | --- |
| `booking:reminder` | technician rooms | `type` (`h24`, `h1`, `min15`), `bookingId`, `scheduledAt`, `message` |
| `booking:travel_reminder` | technician rooms | `bookingId`, `message`, `type: START_TRAVEL_CTA` |
| `booking:travel_escalation` | technician rooms | `bookingId`, `message`, `type: START_TRAVEL_URGENT` |
| `booking_at_risk` | `admin_dashboard` | `bookingId`, `technicianId`, `scheduledAt`, `type` (`SCHEDULED_AT_RISK` / `SCHEDULED_MANUAL_ESCALATION`) |

`h1` and `min15` also send SMS when a technician mobile number is available.
The separate travel-enforcement cron sends `booking:travel_reminder` at about
slot −35 minutes and `booking:travel_escalation` at about slot −25 minutes;
failure to start travel can release the job for re-dispatch.

### Rescheduled

| Event | Room | Key payload |
| --- | --- | --- |
| `booking_rescheduled` | `customer_<customerId>`, `admin_dashboard` | `bookingId`, `scheduledAt`, `scheduledDateLocal`, `scheduledTimeLocal`, `timezone` |

`booking_rescheduled` is emitted as a raw event string; it is not currently in
`Utils/socketConstants.js`. Existing offers are expired before the new
dispatch window opens.

### Cancelled / re-broadcast

| Event | Room | Key payload |
| --- | --- | --- |
| `job_cancelled_by_customer` | assigned technician | `bookingId`, `message`, `type: BOOKING_CANCELLED` |
| `booking:rebroadcast` | customer room | `bookingId`, `message`, `timestamp` |
| `booking_cancelled` | customer room | `bookingId`, `status`, `reason`, `message` (raw underscore event; cron/technician-cancel paths) |
| `booking:cancelled` | customer/technician/admin | Standardized notification event when emitted by the notification worker |

### No-show / at-risk

- `booking_at_risk` is sent to `admin_dashboard` when the technician has not
  started travel.
- At the final enforcement stage the assignment can be released with
  `schedule_travel_no_show`, broadcasts expired, and the booking re-matched
  within `SCHEDULED_REDISPATCH_WINDOW_MINUTES` (default 30).
- If no replacement is found, the normal auto-cancel path notifies the
  customer.

## 8. Postman run order

Import the scheduled collection and the existing environment, then run:

1. `00 - Setup & Authentication`
   - request/verify technician OTP
   - request/verify customer OTP
   - admin password login
   - **Technician - My Profile** (captures `technicianId`)
2. `02 - Technician Base Location & Availability`
   - get/set base location
   - update live location
   - go online
   - register FCM token
3. `01 - Customer Scheduled Booking`
   - get slots (captures `scheduledDate`, `scheduledTime`, `rescheduleDate`, `rescheduleTime`)
   - create scheduled booking (captures `bookingId`, `scheduledAt`)
4. `03 - Technician Job Feed & Lifecycle`
   - **My Jobs** captures `broadcastVersion`
   - accept or decline
   - status updates and completion flow
   - accepted scheduled jobs
   - technician cancel / re-accept
5. `04 - Admin Base Location & Dispatch Ops`
   - missing base locations (captures `technicianId`)
   - get/set technician base location
   - queue stats/health/retry
6. `05 - Socket.IO Handshake & Event Reference`
   - confirm the handshake is reachable; use a Socket.IO client for events
7. `90 - Guard Checks (optional)`
   - blank base-location coordinates → `400`
   - stale accept version → `4xx`

### Environment variables used by this collection

| Variable | Purpose |
| --- | --- |
| `baseUrl` | Server origin |
| `customerToken` / `technicianToken` / `adminToken` | Bearer tokens captured by auth requests |
| `customerMobile` / `technicianMobile` / `adminMobile` | Login identifiers |
| `customerLoginOtp` / `technicianLoginOtp` | OTPs read from SMS |
| `serviceId` | Active service under test |
| `addressId` | Optional saved address for the slots/booking flow |
| `latitude` / `longitude` | GPS and base-location coordinates |
| `scheduledDate` / `scheduledTime` | Slot captured from the slots response |
| `rescheduleDate` / `rescheduleTime` | Second slot used by the reschedule request |
| `bookingId` | Booking under test |
| `scheduledAt` | UTC scheduled instant captured from create/reschedule |
| `broadcastVersion` | Offer version captured from the technician feed |
| `scheduledBookingId` | First accepted scheduled job, if any |
| `technicianId` | Technician profile id for admin base-location requests |
| `districtId` | Optional district filter for the missing-base-location list |
| `outboxId` | Failed dispatch row for admin retry |
| `firebaseToken` | Optional FCM token |
| `completionOtp` | Customer completion OTP |

## 9. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `400 Invalid slot` | Date/time not exactly from `/booking/slots`, or outside the five-day window |
| `400 No valid address or GPS coordinates provided` | Missing/invalid `addressId` or GPS pair |
| `403` on accept | Technician offline, not eligible, or offer belongs to another technician |
| `409` on accept | Stale `version`, offer taken, concurrent claim, or conflicting active job |
| `410` on accept | Offer expired; refetch the feed |
| `409` on reschedule | Assigned/closed booking, same slot, or inside the cutoff |
| `400` on base location | Blank/out-of-range coordinates, or district not allowed |
| No `job:new` for a scheduled booking | Technician preference disabled, no eligible supply, slot already occupied, caps reached, or no live socket (FCM/outbox may still deliver) |
| No `job:new` for an instant booking | Technician offline, no live socket, or no eligible supply |
| Scheduled offer accepted while offline | Not allowed; go online first |
