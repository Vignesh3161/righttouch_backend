# Scheduling Flow, Socket Notifications & Endpoint Map

This is the consolidated reference for the four-slot scheduling system. It
covers the customer booking flow, technician offer/execution flow, backup and
customer no-show handling, the Socket.IO events emitted at each stage, and
every scheduling-related HTTP endpoint by role.

Related references:

- `docs/01-http-endpoints.md` — broader HTTP index
- `docs/02-socket-notifications.md` — connection, rooms, delivery semantics
- `docs/04-scheduled-booking-and-technician-jobs.md` — long-form lifecycle
- `collections/scheduling/righttouch_scheduling_customer.postman_collection.json`
- `collections/scheduling/righttouch_scheduling_technician.postman_collection.json`
- `collections/scheduling/righttouch_scheduling_admin.postman_collection.json`

## 1. Scheduling contract

| Rule | Value |
| --- | --- |
| Bookable days | 5 days: tomorrow + the next 4 days |
| Slots per day | Four 3-hour slots |
| Slot values | `09:00–12:00`, `12:00–15:00`, `15:00–18:00`, `18:00–21:00` |
| Timezone | `BUSINESS_TIMEZONE` (default `Asia/Kolkata`) |
| Scheduled dispatch | Immediate; `dispatchEligibleAt` is `null`/now |
| Slot capacity | One scheduled job per technician per slot |
| Instant work | Blocked only while a scheduled job occupies the slot |
| Travel start | `on_the_way` allowed from slot start − 35 minutes |
| Service start | `in_progress` allowed only at/after slot start |
| Fit rule | Service duration + 30 minutes travel must fit in 180 minutes |
| Reschedules | Maximum 2; blocked inside `RESCHEDULE_CUTOFF_MINUTES` (default 300) |
| Booking state before accept | `pending` / "Awaiting technician" |

The hard concurrency guard is the partial unique index on
`TechnicianSlot { technicianId, slotKey }` where `active: true`.
`SlotHold` / `SlotCapacity` counters are approximate and reconciled every five
minutes.

## 2. Lifecycle at a glance

```
Customer
  GET /api/user/booking/slots
  POST /api/user/booking/schedule
        |
        v
  booking: pending, technicianId: null, slot reserved
        |
        v
Dispatch (immediate)
  job:new / booking:backup_offer -> eligible technicians
  technician:jobs_changed -> feed refresh
        |
        +--> decline / expire / job_taken -> rematch or auto-cancel
        |
        v
  accepted
  booking:accepted + job_accepted -> customer
  job_taken -> other technicians
        |
        v
Pre-slot enforcement
  booking:reminder (h24 / h1 / min15)
  booking:travel_reminder (slot -35m)
  booking:travel_escalation (slot -25m / -15m / -10m)
        |
        v
Execution
  on_the_way -> reached -> in_progress
        |
        +--> late completion risk -> backup offer / backup replacement
        |
        +--> customer no-show -> masked call -> claim -> customer response
        |
        v
Completion
  request completion OTP -> online payment -> verify OTP -> completed
```

## 3. Socket.IO connection and rooms

Use a Socket.IO v4 client; Postman can only probe the Engine.IO handshake.

```js
import { io } from "socket.io-client";

const socket = io(process.env.BASE_URL, {
  transports: ["websocket", "polling"],
  auth: { token: jwt },
});
```

Rooms are joined automatically after authentication.

| Room | Members |
| --- | --- |
| `user:<userId>` | Authenticated user |
| `role:<role>` | All users with that role |
| `technician_<technicianProfileId>` | Technician operational room |
| `customer_<customerId>` | Backward-compatible customer room |
| `admin_dashboard` | Admin/Owner dashboard |

Technician sockets join both `technician_<profileId>` and `user:<userId>`.
Server helpers union the rooms so a socket receives an event once.

Important room details for scheduling:

- `job:new` goes to `user:<technicianUserId>` + `technician_<profileId>`.
- `booking:accepted` goes to `user:<customerId>`; the legacy `job_accepted`
  also goes to `customer_<customerId>`.
- `booking:completed`, `booking_cancelled`, `booking_rescheduled`,
  `booking:rebroadcast`, and customer no-show events use
  `customer_<customerId>`.
- Admin scheduling events use `admin_dashboard`.

## 4. Socket event matrix

### 4.1 Technician events

| Event | Trigger | Room | Key payload |
| --- | --- | --- | --- |
| `job:new` | New instant or scheduled offer | `user:<techUserId>` + `technician_<profileId>` | `bookingId`, `broadcastId`, `version`, `scheduledAt`, service/address/distance fields |
| `booking:backup_offer` | Late-completion backup offer | `technician_<backupProfileId>` | `bookingId`, `message`, `type: "BACKUP_OFFER"`, `slotKey`, `slotLabel` |
| `booking:backup_replaced` | A backup accepted the technician's late-running job | `technician_<originalProfileId>` | `bookingId`, `message` |
| `technician:jobs_changed` | Feed changed (new/expired/backup/extension) | Technician rooms | `{ changed: true, at }` |
| `jobs_changed` | Legacy flat feed event | Technician rooms | `{ action, bookingId, broadcastId, reasons, at }` |
| `job:expired` | Offer expired or revoked | Technician rooms | `{ bookingId, broadcastId, expiresAt, reason, reasons }` |
| `job_taken` | Another technician won the job | `technician_<profileId>` | `{ bookingId, message, timestamp }` |
| `job_cancelled_by_customer` | Customer cancelled an assigned job | `technician_<profileId>` | `{ bookingId, message, type: "BOOKING_CANCELLED" }` |
| `booking:reminder` | Scheduled reminder (`h24`, `h1`, `min15`) | Technician room | `{ type, bookingId, scheduledAt, message }` |
| `booking:travel_reminder` | Slot − 35 minutes, start-travel CTA | Technician room | `{ bookingId, message, type: "START_TRAVEL_CTA" }` |
| `booking:travel_escalation` | Travel not started near slot | Technician room | `{ bookingId, message, type: "START_TRAVEL_URGENT" }` |
| `customer_no_show_response` | Customer says they are available | `technician_<profileId>` | `{ bookingId, available: true, message }` |
| `customer_no_show_confirmed` | Claim confirmed (customer said unavailable or window expired) | `technician_<profileId>` | `{ bookingId, compensationStatus }` |
| `notification:new` | In-app notification row created | `user:<userId>` | `{ type, title, message, bookingId, createdAt }` |
| `session:replaced` | Same account connected elsewhere | Socket | `{ message }` |
| `session:revoked` | Account/token revoked | Socket | `{ reason }` |

`job:new` sample:

```json
{
  "bookingId": "665f...",
  "broadcastId": "6660...",
  "version": 3,
  "serviceId": "6640...",
  "serviceName": "AC Repair",
  "description": "Not cooling",
  "scheduledAt": "2026-11-13T04:30:00.000Z",
  "customerName": "Asha",
  "baseAmount": 499,
  "address": "12 MG Road",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "distanceMeters": 3200,
  "distanceKm": 3.2,
  "distanceStr": "3.2 km"
}
```

Backup offer sample:

```json
{
  "bookingId": "665f...",
  "message": "A scheduled job in your area needs a backup technician. Accept to take over.",
  "type": "BACKUP_OFFER",
  "slotKey": "2026-11-13|15:00",
  "slotLabel": "03:00 PM - 06:00 PM"
}
```

### 4.2 Customer events

| Event | Trigger | Room | Key payload |
| --- | --- | --- | --- |
| `booking:accepted` | Technician accepted; also emitted after backup takeover | `user:<customerId>` | `bookingId`, `technicianId`, `status`, `technicianName`, `message`, `timestamp` |
| `job_accepted` | Legacy alias of `booking:accepted` | `user:<customerId>` + `customer_<customerId>` | Same as above |
| `booking_completed` | Service completed and verified | `customer_<customerId>` | `{ bookingId, message, type: "BOOKING_COMPLETED" }` |
| `booking_cancelled` | Booking cancelled | `customer_<customerId>` | Cancellation DTO + message |
| `booking:rebroadcast` | Assigned technician cancelled while slot is future | `customer_<customerId>` | `{ bookingId, message, timestamp }` |
| `booking_rescheduled` | Scheduled booking moved to a new slot | `customer_<customerId>` + `admin_dashboard` | `bookingId`, `scheduledAt`, `scheduledDateLocal`, `scheduledTimeLocal`, `slotKey`, `slotLabel`, `timezone` |
| `customer_no_show_reported` | Technician opened a no-show claim | `customer_<customerId>` | `{ bookingId, responseDeadline, message }` |
| `payment_due` | Completion OTP requested; payment is now due | Customer room | `{ bookingId, message, type }` |
| `payment_received` | Technician-side payment confirmation | Customer room | `{ bookingId, amount, status }` |
| `payment_success` | Customer payment confirmed | Customer room | Payment payload |
| `payment:status` | Async payment status update | Customer room | Payment status payload |
| `notification:new` | In-app notification row created | `user:<customerId>` | `{ type, title, message, bookingId, createdAt }` |
| `session:replaced` | Same account connected elsewhere | Socket | `{ message }` |

No-show claim sample:

```json
{
  "bookingId": "665f...",
  "responseDeadline": "2026-11-13T10:10:00.000Z",
  "message": "Your technician reported that you were not available. Please respond within 10 minutes."
}
```

The 10-minute auto-confirm cron does **not** emit a socket event. Clients
should refresh the booking or wait for the technician-side confirmation state
to update.

### 4.3 Admin events

| Event | Trigger | Room | Key payload |
| --- | --- | --- | --- |
| `new_booking` | Booking created | `admin_dashboard` | Booking-created DTO |
| `booking_rescheduled` | Customer rescheduled | `admin_dashboard` | Same payload as customer |
| `booking_at_risk` | Travel/late-completion risk | `admin_dashboard` | `{ bookingId, technicianId, scheduledAt?, slotKey?, type }` |
| `booking:payment_overdue` | Completed booking still unpaid | `admin_dashboard` | Payment reminder payload |
| `admin:unread_counts_updated` | Admin notification counts changed | Admin rooms | Count snapshot |
| `withdrawal:requested` | Technician requested payout | `admin_dashboard` | Withdrawal payload |

Known `booking_at_risk` types:

- `SCHEDULED_AT_RISK` — technician has not started travel near the slot.
- `LATE_COMPLETION_NO_BACKUP` — late-running job has no accepting backup.

### 4.4 Delivery semantics

- `job:new` is deduplicated by `broadcastId + technicianId + version`.
- Scheduled offers may be delivered to offline technicians through FCM/outbox,
  but acceptance still requires online presence.
- Feed events are best-effort. REST (`GET /job-broadcast/my-jobs`) is the source
  of truth after reconnect.
- `notification:new` is for the notification tray, not the offer feed.
- Admin compensation approval/rejection/payment does not emit a socket event.

## 5. Flow sequences

### 5.1 Customer creates a scheduled booking

1. `GET /api/user/booking/slots` with `serviceId` and either GPS or `addressId`.
2. Pick one of the four `timeSlots` and one of the five `days`.
3. `POST /api/user/booking/schedule` with `scheduledDate`, `scheduledTime`, and
   location.
4. Server resolves the slot, reserves `TechnicianSlot` + capacity, creates the
   booking as `pending`, and returns `bookingId` / `scheduledAt` / `slotKey`.
5. Dispatch starts immediately. The customer sees "Awaiting technician" until
   a technician accepts.
6. Admin receives `new_booking`; eligible technicians receive `job:new`,
   `technician:jobs_changed`, and possibly `notification:new`.

Idempotency: send `Idempotency-Key` to safely replay the same create request.

### 5.2 Technician accepts or declines

1. Technician refreshes `GET /api/technician/job-broadcast/my-jobs`.
2. Each offer carries `bookingId`, `version`, and `isBackupOffer`.
3. Accept with `PUT /api/technician/job-broadcast/respond/:bookingId`
   `{ "action": "accepted", "version": <version> }`.
4. Decline with the same endpoint using `action: "declined"` and an optional
   `reason`.
5. On accept:
   - booking becomes `accepted` and the slot is confirmed;
   - customer receives `booking:accepted` + `job_accepted`;
   - other technicians receive `job_taken` and a feed refresh;
   - a backup accept also promotes the backup slot and emits
     `booking:backup_replaced` to the original technician.

Version mismatch, expired offer, and concurrent claims return `409`/`410`.
Refresh the feed and retry only when the reason is transient.

### 5.3 Reminders and travel enforcement

- `booking:reminder` at the configured `h24`, `h1`, and `min15` stages.
- `booking:travel_reminder` at slot − 35 minutes.
- `booking:travel_escalation` at slot − 25 / − 15 / − 10 minutes when travel
  has not started.
- At slot − 15 minutes the admin dashboard receives
  `booking_at_risk { type: "SCHEDULED_AT_RISK" }`.
- The technician may mark `on_the_way` no earlier than slot − 35 minutes.

### 5.4 Execution status transitions

Canonical state machine:

```
pending -> broadcasted -> accepted -> on_the_way -> reached -> in_progress -> completed
```

Technician endpoint: `PUT /api/technician/status/:bookingId` with
`{ "status": "on_the_way" | "reached" | "in_progress" }`.

Rules:

- `on_the_way` before slot − 35 minutes → `409 TOO_EARLY_FOR_SLOT`.
- `in_progress` before slot start → `409 SLOT_NOT_STARTED`.
- Direct `completed` → `409 COMPLETION_OTP_REQUIRED`; use completion OTP.
- Status writes are optimistic-concurrency guarded by `version`.

### 5.5 Late completion and backup takeover

1. Watchdog projects that an `in_progress` scheduled job will overrun the
   technician's next slot.
2. Original technician stays assigned.
3. A backup `TechnicianSlot` is reserved and a broadcast is created.
4. Backup technician receives `booking:backup_offer` and a feed refresh.
5. If a backup accepts before slot start − 15 minutes:
   - backup slot becomes primary;
   - original slot is released with `late_completion_replaced`;
   - booking is reassigned to the backup;
   - customer receives `booking:accepted`;
   - original technician receives `booking:backup_replaced`.
6. If no backup accepts by slot start − 15 minutes:
   - original keeps the job;
   - admin receives `booking_at_risk { type: "LATE_COMPLETION_NO_BACKUP" }`;
   - customer is told about the delay.

### 5.6 Customer no-show

Technician prerequisites:

1. Booking is `accepted` / `on_the_way` / `reached`.
2. Technician marked `reached`.
3. Technician placed a masked call:
   `POST /api/technician/booking/:id/masked-call` → `callLogId`.
4. At least 15 minutes have passed since `reachedAt`.
5. Technician is within 100m of the booking location.
6. The call log belongs to the same booking and technician and is after
   `reachedAt`.

Report: `POST /api/technician/booking/:id/customer-no-show`
`{ "callLogId": "<id>" }`.

Result:

- booking enters `customerNoShowStatus: "awaiting_customer"`;
- `customer_no_show_reported` to the customer;
- customer has 10 minutes to call
  `POST /api/user/booking/:id/customer-no-show/respond` with
  `{ "available": true | false }`;
- `available: true` → `rejected`; technician receives
  `customer_no_show_response`;
- `available: false` or timeout → `confirmed`; technician receives
  `customer_no_show_confirmed`;
- three reports in 30 days set `reliabilityReviewRequired`.

Telephony:

- Real calls require `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_MASKED_NUMBER`, and `PUBLIC_BASE_URL`.
- Twilio status callbacks hit `POST /api/telephony/twilio/status` and set
  `verified` on terminal statuses.
- In non-production, `ALLOW_MANUAL_CALL_LOGS=true` permits a manual call log
  when Twilio is absent. Production rejects unverified logs.

Compensation:

- Computed only when `CUSTOMER_NO_SHOW_COMPENSATION_ENABLED=true`.
- 50% of `technicianAmountPaise`, minimum ₹100, capped at booking total.
- Default is disabled; no automatic payout is made.

Admin review: `PUT /api/user/booking/:id/customer-no-show/compensation`
`{ "action": "approve" | "reject" | "mark_paid", "note"?, "providerReference"? }`.

- `approve` requires `recorded`; posts a pending `manual_adjustment` debit.
- `reject` moves a pending ledger entry to `exception`.
- `mark_paid` requires `approved`; flips the ledger entry to `posted`.
- No socket event is emitted for these admin actions.

### 5.7 Reschedule and cancellation

Reschedule:

- `PUT /api/user/booking/reschedule/:id` with
  `{ scheduledDate, scheduledTime, reason }`.
- Only unassigned `pending` / `broadcasted` scheduled bookings.
- New slot must differ; max 2 reschedules; blocked inside the cutoff.
- Old offers expire; the booking is re-dispatched for the new slot.
- `booking_rescheduled` to customer + admin.

Cancellation:

- `PUT /api/user/booking/cancel/:id` with `{ reason }`.
- Pending offers expire; assigned technician receives
  `job_cancelled_by_customer`.
- Fees: free >3h, ₹50 2–3h, ₹100 <2h, ₹120 at door; free when the technician
  is late. Fees are audit-only until the customer wallet exists.

Technician cancellation:

- `PUT /api/technician/booking/technician/cancel/:id`.
- Future slot → `booking:rebroadcast` to customer and rematch.
- Current/past slot → `booking_cancelled` to customer.

### 5.8 Completion

1. `POST /api/technician/booking/:id/completion-otp`.
2. If unpaid, response has `paymentRequired: true`; the OTP challenge is not
   issued yet.
3. Customer pays online.
4. `POST /api/technician/booking/:id/verify-completion-otp` with
   `{ otp }`.
5. Booking becomes `completed`; customer receives `booking_completed`.
6. Slot reservation is released.

Direct `status: "completed"` is rejected. Cash/offline service payment is not
accepted for completion verification.

## 6. Endpoint map

### 6.1 Public and authentication

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/user/booking/slots` | Public (customer token only for `addressId`) | Five days × four slots + instant ETA |
| POST | `/api/user/login/customer` | Public | Send customer login OTP |
| POST | `/api/user/login/customer/verify-otp` | Public | Returns customer token |
| POST | `/api/technician/login/technician` | Public | Send technician login OTP |
| POST | `/api/technician/login/technician/verify-otp` | Public | Returns technician token |
| POST | `/api/user/login/owner` | Public | Admin/Owner password login |
| GET | `/socket.io/?EIO=4&transport=polling` | Public probe | Handshake reachability only |

### 6.2 Customer scheduling endpoints

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| POST | `/api/user/booking/schedule` | `serviceId`, `bookingType: "scheduled"`, `scheduledDate`, `scheduledTime`, `locationType`, `addressId` or `latitude`/`longitude`, `faultProblem`, optional `tipAmount` | Creates a scheduled booking; immediate dispatch |
| PUT | `/api/user/booking/reschedule/:id` | `scheduledDate`, `scheduledTime`, `reason` | Unassigned only; max 2; cutoff applies |
| PUT | `/api/user/booking/cancel/:id` | `{ "reason": "..." }` | Scheduled cancellation fees apply |
| GET | `/api/user/booking/reasons` | — | Cancellation reason catalog |
| GET | `/api/user/booking/getCustomerBookings` | `status`, `paymentStatus`, `bookingType`, `search`, `page`, `limit`, `filter` | Customer booking list |
| GET | `/api/user/booking/:id/completion-status` | — | Safe completion/payment status |
| POST | `/api/user/booking/:id/customer-no-show/respond` | `{ "available": true \| false }` | 10-minute response window |
| POST | `/api/user/booking/book-again` | `previousBookingId`, `bookingType: "scheduled"`, `scheduledDate` + `scheduledTime` (or `scheduledAt`), optional location override | Completed + paid previous bookings only |
| DELETE | `/api/user/booking/:id` | — | Delete a booking |
| POST | `/api/user/cart/set-schedule` | `itemId`, `bookingDate` (or `scheduledDate`), `timeSlot` (or `scheduledTime`), `faultProblem` | Schedules a service cart item |
| POST | `/api/user/checkout` | `addressId` or address/location fields, `scheduledAt` ISO | Cart checkout; scheduled cart items must fit one slot |

Scheduled create example:

```json
{
  "serviceId": "<active-service-id>",
  "bookingType": "scheduled",
  "scheduledDate": "2026-11-13",
  "scheduledTime": "15:00",
  "locationType": "gps",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "faultProblem": "Not cooling"
}
```

Cart schedule example:

```json
{
  "itemId": "<cart-item-id>",
  "bookingDate": "2026-11-13",
  "timeSlot": "03:00 PM - 06:00 PM",
  "faultProblem": "Not cooling"
}
```

### 6.3 Technician scheduling endpoints

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/technician/job-broadcast/my-jobs` | — | Offer feed; `result[].version`, `isBackupOffer` |
| PUT | `/api/technician/job-broadcast/respond/:bookingId` | `action`/`status`/`response`/`decision`, `version`, optional `reason` | Accept or decline; versioned |
| GET | `/api/technician/jobs/accepted/scheduled` | — | Accepted scheduled jobs |
| GET | `/api/technician/jobs/current` | — | Active jobs |
| GET | `/api/technician/jobs/accepted` | — | All accepted jobs |
| GET | `/api/technician/jobs/history` | — | Technician history |
| PUT | `/api/technician/status/:bookingId` | `{ "status": "on_the_way" \| "reached" \| "in_progress" }` | Direct `completed` is rejected |
| POST | `/api/technician/booking/:id/masked-call` | — | Returns `callLogId`; required for no-show |
| POST | `/api/technician/booking/:id/customer-no-show` | `{ "callLogId": "<id>" }` | Requires reached + 15 min + 100m geofence |
| PUT | `/api/technician/booking/technician/cancel/:id` | `{ "reason": "..." }` | Penalty + future-slot rematch |
| PUT | `/api/technician/booking/reaccept/:id` | — | Re-accept a previously cancelled job |
| POST | `/api/technician/booking/:id/completion-otp` | — | Requests completion verification |
| POST | `/api/technician/booking/:id/completion-otp/resend` | — | Resends/rotates OTP after payment |
| POST | `/api/technician/booking/:id/verify-completion-otp` | `{ "otp": "<otp>" }` | Completes after online payment |
| GET | `/api/technician/booking/:id/completion-status` | — | Safe completion status |
| PUT | `/api/technician/location` | `{ "latitude": ..., "longitude": ... }` | Live GPS; rate-limited |
| GET | `/api/technician/service-base-location/me` | — | Scheduled matching origin |
| PUT | `/api/technician/service-base-location/me` | `{ "latitude": ..., "longitude": ... }` | Must be in an allowed district |
| PUT | `/api/technician/updateTechnician` | `{ "availability": { "isOnline": true } }` | Go online; acceptance requires online presence |
| PUT | `/api/technician/fcm-token` | `{ "token": "<fcm>", "unregister": false }` | Register/remove push token |

### 6.4 Admin scheduling and operations endpoints

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/dispatch/stats` | — | Queue counts, retries, delivery metrics |
| GET | `/api/admin/dispatch/health` | — | Worker/Redis health |
| GET | `/api/admin/dispatch/failed` | `page`, `limit` | Failed rows |
| GET | `/api/admin/dispatch/pending` | `status=pending\|inflight\|all`, `page`, `limit` | Pending/inflight rows |
| POST | `/api/admin/dispatch/:id/retry` | — | Requeue one row; `409` on live duplicate |
| POST | `/api/admin/dispatch/retry-failed` | — | Requeue up to 1000 failed rows |
| POST | `/api/admin/dispatch/worker/restart` | — | Restart in-process worker |
| POST | `/api/admin/dispatch/worker/stop` | — | Maintenance only |
| GET | `/api/user/booking/getAllBookings` | `status`, `customerMobile`, `technicianMobile`, `limit`, `skip` | Admin booking list |
| GET | `/api/user/booking/getBookingById/:id` | — | Full booking detail |
| GET | `/api/admin/zone-geofence/jobs/:bookingId/broadcast-audit` | — | Offer/version/expiry audit |
| GET | `/api/admin/zone-geofence/zone-health-dashboard` | — | Zone/supply health |
| GET | `/api/technician/admin/service-base-location/missing` | `page`, `limit`, optional `districtId` | Technicians missing base location |
| GET | `/api/technician/admin/technicians/:technicianId/service-base-location` | — | Read one base location |
| PUT | `/api/technician/admin/technicians/:technicianId/service-base-location` | `latitude`, `longitude`, `verified`, `force`, `reason` | Set/verify base location |
| PUT | `/api/user/booking/:id/customer-no-show/compensation` | `action: "approve" \| "reject" \| "mark_paid"`, `note`, optional `providerReference` | Compensation review |
| DELETE | `/api/user/booking/admin/:id` | — | Admin delete |

## 7. Error and reason codes

| Code / status | Meaning |
| --- | --- |
| `SLOT_BUSY` | Slot no longer available |
| `NO_ELIGIBLE_TECHNICIAN` | No supply for the slot/service/zone |
| `MULTI_ITEM_SAME_SLOT_NOT_SUPPORTED` | Cart checkout contains multiple items in one slot |
| `TOO_EARLY_FOR_SLOT` | `on_the_way` before slot − 35 minutes |
| `SLOT_NOT_STARTED` | `in_progress` before slot start |
| `COMPLETION_OTP_REQUIRED` | Direct `completed` status rejected |
| `PAYMENT_REQUIRED` | Completion OTP requested before payment |
| `CALL_LOG_REQUIRED` | No-show report missing `callLogId` |
| `CALL_LOG_INVALID` | Call log not found for this booking/technician |
| `CALL_LOG_UNVERIFIED` | Provider did not verify the call |
| `CALL_LOG_BEFORE_REACHED` | Call was placed before `reachedAt` |
| `NO_SHOW_WAIT_NOT_MET` | Less than 15 minutes since `reachedAt` |
| `NO_SHOW_GEOFENCE_FAILED` | Technician farther than 100m |
| `TELEPHONY_NOT_CONFIGURED` | No Twilio config and manual logs disabled |
| `TELEPHONY_PROVIDER_ERROR` | Twilio call creation failed |
| `NO_SHOW_NOT_CONFIRMED` | Compensation review before claim confirmation |
| `INVALID_COMPENSATION_STATE` | Action not valid for the current compensation state |
| `NOTHING_TO_APPROVE` | Confirmed claim has no compensation amount |
| `LEDGER_ENTRY_MISSING` | `mark_paid` cannot find the liability entry |
| `409` on accept | Stale version, taken, closed, or concurrent claim |
| `410` on accept | Offer expired; refresh the feed |

## 8. Postman collections and run order

### Standalone role collections

| Role | Collection |
| --- | --- |
| Customer | `collections/scheduling/righttouch_scheduling_customer.postman_collection.json` |
| Technician | `collections/scheduling/righttouch_scheduling_technician.postman_collection.json` |
| Admin | `collections/scheduling/righttouch_scheduling_admin.postman_collection.json` |

Run order:

1. Customer: `00 - Setup & Auth` → `01 - Slot Discovery & Booking` →
   `02 - Lifecycle & No-Show`.
2. Technician: `00 - Setup & Auth` → `01 - Job Feed & Accept` →
   `02 - Execution & No-Show` → `03 - Completion`.
3. Admin: `00 - Setup & Auth` → `01 - Dispatch & Booking Ops` →
   `02 - No-Show Compensation`.

### Combined smoke flow

1. Customer collection: get slots, create scheduled booking. Capture
   `bookingId`, `scheduledDate`, `scheduledTime`.
2. Technician collection: get offer feed, accept the booking. Capture
   `broadcastVersion`.
3. Technician collection: mark `on_the_way` → `reached` → `in_progress`.
4. Technician collection: start masked call, then report customer no-show.
5. Customer collection: respond to the no-show claim.
6. Admin collection: inspect the booking and review compensation.
7. Technician collection: request and verify completion OTP after payment.

### Canonical role collections

The scheduling folder is also inserted into the existing canonical
collections:

- Customer: `5.1 Scheduling, Backup & No-Show`
- Technician: `5.1 Scheduling, Backup & No-Show`
- Admin: `14.1 Scheduling, Dispatch & No-Show`

## 9. Key data fields

| Field | Meaning |
| --- | --- |
| `bookingType` | Stored as `schedule`; client-facing value is `scheduled` |
| `scheduledAt` | UTC instant built from the business-timezone wall clock |
| `scheduledDateLocal` / `scheduledTimeLocal` | Business-timezone display values |
| `slotKey` | `YYYY-MM-DD|HH:MM` |
| `slotStartAt` / `slotEndAt` | UTC slot boundaries |
| `dispatchEligibleAt` | `null`/now for immediate scheduled dispatch |
| `autoCancelAt` | `scheduledAt − 5h`, floored to `now + 5m` |
| `technicianId` | Current assigned technician |
| `originalTechnicianId` | Technician before a backup replacement |
| `backupTechnicianId` | Pending backup candidate |
| `replacementTechnicianId` | Backup that accepted |
| `lateCompletionAtRisk` | Watchdog marked the job at risk |
| `customerNoShowStatus` | `none`, `awaiting_customer`, `confirmed`, `rejected` |
| `customerNoShowResponseDeadline` | Customer response deadline |
| `customerNoShowCompensationPaise` | Recorded compensation amount |
| `customerNoShowCompensationStatus` | `none`, `recorded`, `approved`, `rejected`, `paid` |
