# RightTouch API, Dispatch & Socket Collection

Reference material and a Postman collection for the RightTouch dispatch,
technician job feed, completion/payment, and real-time Socket.IO flows.

Everything in this folder is documentation/test tooling. It contains no
production secrets.

## Layout

```
postmancollection/
├── docs/
│   ├── 01-http-endpoints.md          HTTP endpoint reference
│   ├── 02-socket-notifications.md    Socket.IO connection, rooms, events
│   ├── 03-dispatch-rebroadcast.md    Dispatch modes, outbox, retry playbook
│   ├── 04-scheduled-booking-and-technician-jobs.md
│   │                                  Scheduled booking + technician lifecycle
│   ├── 05-manual-payouts.md          Manual payout flows, sockets, notifications
│   └── 06-scheduling-flow-sockets-endpoints.md
│                                      Consolidated scheduling flow, sockets,
│                                      and per-role endpoint map
├── collections/
│   ├── righttouch_dispatch_and_socket.postman_collection.json
│   ├── righttouch_manual_payouts.postman_collection.json
│   ├── righttouch_scheduled_booking_and_technician_jobs.postman_collection.json
│   └── scheduling/
│       ├── righttouch_scheduling_customer.postman_collection.json
│       ├── righttouch_scheduling_technician.postman_collection.json
│       └── righttouch_scheduling_admin.postman_collection.json
└── environments/
    ├── righttouch_dispatch_and_socket.postman_environment.json
    └── righttouch_manual_payouts.postman_environment.json
```

The Postman collections and their environment are kept in separate folders so
the JSON fixtures stay separate from the written reference.

> The focused pay-before-completion and product quote-to-completion collections
> remain in `../postman/` as end-to-end scenarios with assertions. Other files
> directly under `postman/` stay gitignored; `postman/postmancollection/` is
> tracked via negated patterns in `.gitignore`.

## Quick start

1. Import the environment and the collection(s) you need from `collections/` and `environments/` into Postman.
2. Select the **RightTouch - Dispatch & Socket** environment.
3. Fill in the mobile numbers and admin password.
4. Run the folders in order:
   - `00 - Authentication`
   - `01 - Customer Create Booking`
   - `02 - Technician Dispatch`
   - `03 - Completion OTP & Payment`
   - `04 - Admin Dispatch Ops`
   - `05 - Socket.IO Handshake Probe`
   - `06 - Scheduled Booking & Base Location`
5. For OTP logins, read the SMS OTP and put it into the matching environment
   variable (`customerLoginOtp` / `technicianLoginOtp`) before running the
   verify request.

### Suggested dispatch smoke order

The folders group related requests; for a single-booking smoke test run:

1. Authenticate the technician, customer, and admin.
2. `02 - Technician Dispatch` → **Update Location**, then **Go Online**.
3. `01 - Customer Create Booking` → **Create Instant Booking** (captures
   `bookingId`).
4. `02 - Technician Dispatch` → **My Jobs** (captures `bookingId` and
   `broadcastVersion`), then **Accept Job** or **Decline Job**.
5. `04 - Admin Dispatch Ops` → **Queue Stats**, **Failed Rows**,
   **Retry Row**.
6. `05 - Socket.IO Handshake Probe` → confirm the Socket.IO endpoint is
   reachable, then use a Socket.IO client for event-level testing.

### Manual payout smoke order

Use `righttouch_manual_payouts.postman_collection.json` with
`righttouch_manual_payouts.postman_environment.json`:

1. `00 - Setup & Auth` — technician OTP login; admin, owner, and second-admin
   password logins.
2. `01 - Payout Configuration` — read/update global min/max/cooldown/dual
   approval settings.
3. `02 - Technician Withdrawal` — read wallet limits and request a withdrawal
   (captures `withdrawalId`).
4. `03 - Admin Review & Release` — queue, audited details, approve, mark paid,
   receipt, exports.
5. `04 - Admin Direct & Dual Approval` — send-money, second-admin approval,
   freeze/unfreeze.
6. `05 - Notifications` — admin/technician notification trays.
7. `06 - Socket.IO Probe` — handshake only; use a Socket.IO client for events.
8. `07 - Guard Cases` — optional expected-4xx checks.

Payouts are manual-only: automatic execution is permanently disabled. See
`docs/05-manual-payouts.md` for the flow, status model, and the current vs
recommended socket/notification contract.

### Scheduled-booking smoke order

Use the dedicated collection
`righttouch_scheduled_booking_and_technician_jobs.postman_collection.json`:

1. `00 - Setup & Authentication` (technician, customer, admin; **My Profile**
   captures `technicianId`).
2. `02 - Technician Base Location & Availability` (set base location, update
   GPS, go online).
3. `01 - Customer Scheduled Booking` (get slots, create scheduled booking,
   optional reschedule/cancel).
4. `03 - Technician Job Feed & Lifecycle` (My Jobs -> accept/decline -> status
   updates -> completion).
5. `04 - Admin Base Location & Dispatch Ops` (review missing base locations,
   queue health/retry).
6. `05 - Socket.IO Handshake & Event Reference`.
7. `90 - Guard Checks (optional)`.

See `docs/04-scheduled-booking-and-technician-jobs.md` for the full sequence
and expected socket events.

### Per-role scheduling collections

Use the focused collections in `collections/scheduling/` when you want one
runnable flow per role:

1. `righttouch_scheduling_customer.postman_collection.json` — auth, slot
   discovery, create/reschedule/cancel, no-show response.
2. `righttouch_scheduling_technician.postman_collection.json` — auth, offer
   feed, accept/decline, execution status, masked call, no-show, completion.
3. `righttouch_scheduling_admin.postman_collection.json` — auth, dispatch
   health/retry, booking inspection, broadcast audit, base location, no-show
   compensation review.

Run them in that order for a combined smoke test. The same requests are also
inserted into the canonical role collections under
`5.1 Scheduling, Backup & No-Show` (Customer/Technician) and
`14.1 Scheduling, Dispatch & No-Show` (Admin).

See `docs/06-scheduling-flow-sockets-endpoints.md` for the consolidated flow,
socket event matrix, and endpoint map.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `baseUrl` | Server origin, e.g. `http://localhost:5000` |
| `customerToken` | Customer bearer token (captured by the verify request) |
| `technicianToken` | Technician bearer token (captured by the verify request) |
| `adminToken` | Admin/Owner bearer token (captured by the login request) |
| `customerMobile` / `technicianMobile` / `adminMobile` | Login identifiers |
| `adminPassword` / `adminRole` | Admin/Owner password login |
| `customerLoginOtp` / `technicianLoginOtp` | OTP values read from SMS |
| `serviceId` | Active service id used by the create-booking request |
| `bookingId` | Booking under test; auto-captured from create booking or the technician feed |
| `broadcastVersion` | Broadcast version used by accept/decline; auto-captured |
| `outboxId` | Failed dispatch row; auto-captured by the failed-list request |
| `latitude` / `longitude` | Technician GPS position for location updates |
| `firebaseToken` | Optional FCM token for `/fcm-token` |
| `razorpayOrderId` / `razorpayPaymentId` / `razorpaySignature` | Values for the payment verify request |
| `completionOtp` | Customer SMS OTP read from the phone and submitted by the technician |
| `addressId` | Optional saved address for slots/booking |
| `scheduledDate` / `scheduledTime` | Slot captured from the slots response |
| `rescheduleDate` / `rescheduleTime` | Second slot used by reschedule |
| `scheduledAt` | UTC scheduled instant captured from create/reschedule |
| `scheduledBookingId` | First accepted scheduled job, if any |
| `technicianId` | Technician profile id for admin base-location requests |
| `districtId` | Optional district filter for missing-base-location review |

## Related docs

- `docs/01-http-endpoints.md`
- `docs/02-socket-notifications.md`
- `docs/03-dispatch-rebroadcast.md`
- `docs/04-scheduled-booking-and-technician-jobs.md`
- `docs/05-manual-payouts.md`
- `docs/06-scheduling-flow-sockets-endpoints.md`
