# HTTP Endpoints

Base URL in local development: `http://localhost:5000`.

## Conventions

- Authenticated routes use `Authorization: Bearer <JWT>`.
- JSON bodies use `Content-Type: application/json`.
- Success responses generally follow
  `{ "success": true, "message": "...", "result": ... }`.
- Failures generally follow
  `{ "success": false, "message": "..." }`, sometimes with `reason`,
  `reasons`, or `details`.
- Write endpoints are rate-limited. Repeated retries can return HTTP `429`.
- Offer accept/decline is versioned. Send the `version` from the job DTO and
  handle `409 version_mismatch` by refreshing the feed.

## Authentication

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/technician/login/technician` | `{ "identifier": "<mobile>" }` | Sends a technician login OTP |
| POST | `/api/technician/login/technician/verify-otp` | `{ "identifier": "<mobile>", "otp": "<otp>" }` | Returns `result.token` |
| POST | `/api/user/login/customer` | `{ "identifier": "<mobile>", "role": "Customer" }` | Sends a customer login OTP |
| POST | `/api/user/login/customer/verify-otp` | `{ "identifier": "<mobile>", "otp": "<otp>", "role": "Customer" }` | Returns `result.token` |
| POST | `/api/user/login` | `{ "identifier": "<mobile>", "password": "<password>", "role": "Admin" }` | Admin/Owner password login |

Technician tokens must belong to an approved, non-suspended technician
profile. The server resolves `technicianProfileId` from the user account, not
from a client-supplied value.

## Technician dispatch endpoints

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| PUT | `/api/technician/location` | `{ "latitude": 12.97, "longitude": 77.59 }` | Updates GPS and may trigger matching (rate-limited) |
| PUT | `/api/technician/updateTechnician` | `{ "availability": { "isOnline": true } }` | Goes online; requires a fresh GPS ping first |
| PUT | `/api/technician/fcm-token` | `{ "token": "<fcm>", "unregister": false }` | Registers/removes a device push token |
| GET | `/api/technician/job-broadcast/my-jobs` | — | Returns the live offer feed; `result[].version` is the offer version |
| PUT | `/api/technician/job-broadcast/respond/:bookingId` | `{ "action": "accepted", "version": 3 }` | Accepts an offer |
| PUT | `/api/technician/job-broadcast/respond/:bookingId` | `{ "action": "declined", "version": 3, "reason": "not_available" }` | Declines an offer; `reason` is stored on the offer audit row |
| GET | `/api/technician/jobs/current` | — | Current active jobs |
| GET | `/api/technician/jobs/accepted` | — | Accepted jobs, newest first |
| GET | `/api/technician/jobs/accepted/scheduled` | — | Accepted scheduled jobs only |
| GET | `/api/technician/jobs/history` | — | Technician job history |
| PUT | `/api/technician/status/:bookingId` | `{ "status": "on_the_way" }` | Allowed: `on_the_way`, `reached`, `in_progress`, `completed` |
| PUT | `/api/technician/booking/technician/cancel/:bookingId` | `{ "reason": "technician_unavailable" }` | Cancels an assigned job; records the technician penalty and suppresses immediate re-offer |
| PUT | `/api/technician/booking/reaccept/:bookingId` | — | Re-accepts a job this technician previously cancelled; penalty is server-authoritative |
| GET | `/api/technician/service-base-location/me` | — | Stable travel origin used for scheduled matching |
| PUT | `/api/technician/service-base-location/me` | `{ "latitude": 12.97, "longitude": 77.59 }` | Self-service base location; district must be allowed |
| PUT | `/api/technician/:technicianId/training` | `{ "trainingCompleted": true }` | Admin/Owner only; technicians receive `403`. Technicians cannot self-approve training or force an offline state through their own profile update. |

### Accept/decline responses

- `200` — accepted or declined successfully.
- `403` — not assigned to this technician, or the technician is no longer
  eligible.
- `409` — booking taken/closed, version mismatch, concurrent dispatch lock, or
  a conflicting accepted job. Refresh the feed and retry only when the reason
  is transient.
- `410` — offer expired. Refresh the feed; do not retry the same offer.

Declining the last live offer triggers an immediate rematch when
`DISPATCH_REBROADCAST_MODE=notify_new`. The rematch is best-effort and
non-blocking; the 10-minute cron remains the fallback.

## Scheduled booking endpoints

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/user/booking/slots` | `serviceId`, plus `latitude`/`longitude` or `addressId` | Public; an optional bearer token is required only to resolve `addressId`. Returns instant ETA plus five days (tomorrow + 4) with four 3-hour slots: 09:00–12:00, 12:00–15:00, 15:00–18:00, 18:00–21:00 (business timezone), with supply-aware availability |
| POST | `/api/user/booking/schedule` | `serviceId`, `bookingType: "scheduled"`, `scheduledDate`, `scheduledTime`, location | Creates the booking with `slotKey`/`slotStartAt`/`slotEndAt`; scheduled dispatch starts immediately and the customer sees "Awaiting technician" until accepted |
| PUT | `/api/user/booking/reschedule/:id` | `scheduledDate`, `scheduledTime`, `reason` | Unassigned scheduled bookings only; max 2 reschedules; blocked inside `RESCHEDULE_CUTOFF_MINUTES` (default 300) |
| PUT | `/api/user/booking/cancel/:id` | `{ "reason": "..." }` | Scheduled fees: free >3h, ₹50 2–3h, ₹100 <2h, ₹120 at door; free when the technician is late |
| GET | `/api/user/booking/getCustomerBookings` | — | Customer booking list |

Scheduled creation example:

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

Use `locationType: "saved"` with `addressId` instead of GPS coordinates.
Scheduled dispatch is immediate; `dispatchEligibleAt` is `null`/now.
Scheduled offers can be delivered to offline technicians via FCM/outbox, but
acceptance still requires online presence. See
`docs/04-scheduled-booking-and-technician-jobs.md` for the full lifecycle and
socket sequence, and `docs/06-scheduling-flow-sockets-endpoints.md` for the
consolidated scheduling flow, socket matrix, and per-role endpoint map.

## Technician base-location endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/technician/service-base-location/me` | Technician | Read own base location and allowed districts/zones |
| PUT | `/api/technician/service-base-location/me` | Technician | Set own base location; stored with `source=self`, `verified=false` |
| GET | `/api/technician/admin/service-base-location/missing?page=1&limit=50` | Admin/Owner | Approved technicians missing/unverified base location; optional `districtId` |
| GET | `/api/technician/admin/technicians/:technicianId/service-base-location` | Admin/Owner | Read one technician |
| PUT | `/api/technician/admin/technicians/:technicianId/service-base-location` | Admin/Owner | Set/verify; `{ latitude, longitude, verified, force, reason }` |

Scheduled matching uses `serviceBaseLocation` as the travel origin and falls
back to live `location`. Admin updates may set `force=true` to override the
technician's approved-district restriction; every change is audit-logged.

## Customer completion and payment endpoints

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/user/booking/schedule` | Creates an instant or scheduled service booking; returns `result.bookingId` |
| GET | `/api/user/booking/:id/completion-status` | Safe completion status (no OTP/hash) |
| GET | `/api/user/booking/getCustomerBookings` | Customer booking list |
| GET | `/api/user/payments/summary` | Payment summary |
| GET | `/api/user/payments/:bookingId` | Payment detail |
| POST | `/api/user/payments/:bookingId/order` | Creates the payment order; rejected until the completion OTP has been requested (`PAYMENT_NOT_DUE`) |
| POST | `/api/user/payment/verify` | Verifies the provider payment; service completion still requires technician OTP verification |
| POST | `/api/user/payments/:bookingId/cash/declare` | Product bookings only; service bookings return `SERVICE_OFFLINE_PAYMENT_DISABLED` |

Technician completion endpoints used by the same flow:

| Method | Path |
| --- | --- |
| POST | `/api/technician/booking/:id/completion-otp` |
| POST | `/api/technician/booking/:id/completion-otp/resend` |
| POST | `/api/technician/booking/:id/masked-call` | Creates a system-logged masked call to the customer and returns `callLogId` |
| POST | `/api/technician/booking/:id/customer-no-show` | Technician reports a customer no-show after reaching; requires a backend `callLogId`, 15-minute wait, and 100m geofence |
| PUT | `/api/user/booking/:id/customer-no-show/compensation` | Admin/Owner review: `approve`, `reject`, or `mark_paid`; approval posts a pending platform liability |
| POST | `/api/telephony/twilio/status` | Twilio status callback; updates call logs and verifies completed/no-answer attempts |
| POST | `/api/user/booking/:id/customer-no-show/respond` | Customer response to an open no-show claim (`available: true/false`); 10-minute window |
| POST | `/api/technician/booking/:id/verify-completion-otp` |
| GET | `/api/technician/booking/:id/completion-status` |

`completion-otp` sets `completionOtpRequestedAt` and, when the booking is unpaid,
returns `paymentRequired: true` with `verificationStatus: "awaiting_payment"`.
It persists/sends a `PAYMENT_DUE` notification and socket event but does **not**
create an OTP challenge or send an SMS. A successful online service payment
automatically issues the challenge and sends the OTP SMS. `resend` returns
`PAYMENT_REQUIRED` before payment; after payment it rotates the OTP.

`verify-completion-otp` requires `booking.paymentStatus === "paid"` and a
successful Razorpay service payment; cash/offline service payments are rejected
and verification returns `PAYMENT_REQUIRED` until an online payment is captured.

## Admin dispatch operations

All routes require an Admin/Owner bearer token.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/dispatch/stats` | Queue counts, retry distribution, delivery metrics |
| GET | `/api/admin/dispatch/health` | Redis/worker reachability snapshot |
| GET | `/api/admin/dispatch/failed?page=1&limit=25` | Failed dispatch rows |
| GET | `/api/admin/dispatch/pending?status=pending` | Pending/inflight rows; `status=all` returns both |
| POST | `/api/admin/dispatch/:id/retry` | Requeues one failed/pending row |
| POST | `/api/admin/dispatch/retry-failed` | Requeues up to 1000 failed rows |
| POST | `/api/admin/dispatch/worker/restart` | Restarts the in-process dispatch worker |
| POST | `/api/admin/dispatch/worker/stop` | Stops the worker; use only during maintenance |

`POST /:id/retry` returns `409` when another live row already exists for the
same booking + technician + kind. That is expected; do not create a duplicate.

## Example requests

Create an instant booking (GPS location):

```json
{
  "serviceId": "<active-service-id>",
  "locationType": "gps",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "faultProblem": "Not cooling",
  "bookingType": "instant"
}
```

For a scheduled booking, send `"bookingType": "scheduled"` plus the
`scheduledDate` / `scheduledTime` pair returned by `GET /api/user/booking/slots`.
An optional `addressId` (owned by the customer) takes precedence over GPS.

Technician location:

```bash
curl -X PUT "$BASE_URL/api/technician/location" \
  -H "Authorization: Bearer $TECH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"latitude":12.9716,"longitude":77.5946}'
```

Accept a job:

```bash
curl -X PUT "$BASE_URL/api/technician/job-broadcast/respond/$BOOKING_ID" \
  -H "Authorization: Bearer $TECH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"accepted","version":3}'
```

Admin queue health:

```bash
curl "$BASE_URL/api/admin/dispatch/stats" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Common status codes

| Code | Meaning |
| --- | --- |
| `200` | Success |
| `400` | Invalid body/action |
| `401` | Missing/invalid/revoked token |
| `403` | Role or account not allowed |
| `404` | Booking/dispatch row not found |
| `409` | Conflict: version, claim, lock, or already taken |
| `410` | Offer expired |
| `429` | Rate limited |
| `500` | Unexpected server error |
