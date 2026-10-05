# Runtime Concepts End-to-End (Polling, Dispatch, Socket, Outbox, Matching, Geo, Money, Notify, Auth, Crons, Idempotency, Audit)

> Every runtime mechanism used in this codebase: what the concept is generically,
> how this repo implements it, which modules use it, and how they interact on live
> flows. File paths are post-restructure. companion: `modules/README.md`,
> `docs/BACKEND_MODULES_RESPONSIBILITIES.md`, `docs/module-audits/`.

---

## 1. Concept map (one glance — all concepts)

| # | Concept | Generic idea | This repo's implementation | Owner module(s) |
|---|---|---|---|---|
| 1 | **Worker poll loop** | Background timer claims due rows atomically | `setInterval` claim-poll over Mongo outbox collections (no Redis/RabbitMQ) | booking, notifications, payments, payouts, refunds, quote-product |
| 2 | **Push over polling** | Server pushes on change instead of client asking on a timer | `technician:jobs_changed` socket push; `technician:get_jobs` is cursor-polled fallback only. **No HTTP long-polling endpoint exists** | notifications (sender), technician (consumer contract), booking (emitters) |
| 3 | **Dispatch queue** | Decide recipients in-TX, deliver async with retry | `DispatchOutbox` (one row per booking×technician) + bounded worker (50/batch, 10 concurrent, pre-send guard, backoff ×6 → failed) | booking |
| 4 | **Socket layer** | Persistent bidirectional channel: rooms, events, acks, presence | Socket.IO: handshake limiter → `socketAuth` → room joins → acked handlers, single-session kick, budgets | notifications + `index.js`, `shared/middleware`+`shared/utils` |
| 5 | **Transactional outbox family** | Business write + event row commit atomically; worker delivers later | 6 outboxes (Booking, Dispatch, Notification, Payout, Refund, QuotationDelivery), all same claim/retry/reclaim DNA | booking ×2, notifications, payouts, refunds, quote-product |
| 6 | **Matching & broadcast fan-out** | Score candidates → offer to many → exactly one winner claims | Eligibility filter → `JobBroadcast(sent)` per tech + `activeBroadcastVersion` → atomic `findOneAndUpdate` claim; losers expired + `jobs_changed{removed}` | booking (engine), technician (eligibility input), geo (zone/permission input) |
| 7 | **Geo-fence resolution** | Point-in-polygon decides jurisdiction + availability | `$geoIntersects` GPS → OperationalCity(district) → CityZone → `ZoneServiceMapping` → layered `ServiceAvailability` (ZONE/CITY override DISTRICT) | geo (resolver), booking/cart/catalog (gates), technician (registration + mismatch) |
| 8 | **Money pipeline** | Collect → hold → settle → pay out → refund, every step ledger-backed | Razorpay order→verify/webhook→`Payment`; `completed+paid`→`WalletTransaction` credits + `PlatformLedgerEntry`; withdrawal→reserve→RazorpayX→webhook finalize; refund→reserve + clawback cascade + reversal on failure | payments (in), payouts (settle/out), refunds (back) |
| 9 | **Notification fan-out** | One event → per-channel deliveries with independent fate | `notify()` → `Notification` + `NotificationDelivery` per channel + `NotificationOutbox` → worker → adapters (socket/push/SMS/WA/mail) honoring `NotificationPreference` + template render | notifications (all modules trigger it) |
| 10 | **OTP → JWT sessions** | Prove phone once, then bearer token verified per request | CSPRNG OTP (bcrypt, 5-min, 5 attempts) → verify in TX (signup creates User+Profile) → HS256 JWT 7d → per-request `resolveAuthSubject` (status/role/version/workStatus) on HTTP *and* socket | identity (flows), `shared/middleware` (gates) |
| 11 | **Cron sweeps & expiry** | Time-based transitions: expire, remind, escalate, reconcile, auto-pay | `bookingCron` (autoCancel/reminders/OTW-timeout), `attemptExpirySweeper`, `paymentCrons` (reconcile/backstop), refund reconcile + ClassA scan + SLA, `autoPayout` 6h, quotation expiry | booking, payments, refunds, payouts, quote-product |
| 12 | **Idempotency / exactly-once** | Replays and races collapse to one effect | `idempotencyKey` uniques + conditional status updates + `version` CAS + unique (booking×tech) pairs + webhook `eventId` dedupe | every money/dispatch/auth module |
| 13 | **Audit trail** | Who changed what, when, before→after | `AuditLog` append-only via never-throws `writeAuditLog()` on money/status/admin/KYC acts | support-system (store), all modules (emit) |

---

## 2. Polling — what exists here and what deliberately does NOT

### 2.1 No HTTP long-polling anywhere (verified)

There is no endpoint that holds a request open waiting for data (no `await new Promise` on change feeds, no deferred responses in any controller or route). If you come from a long-polling background, do not look for one: the realtime story here is **sockets + worker poll loops**.

### 2.2 Worker poll loops (server-side polling of the database)

Every async pipeline in this backend is a timer that polls a Mongo collection and atomically claims work. Same pattern, four places:

```text
setInterval(tick) → findOneAndUpdate({status:"pending", nextAttemptAt ≤ now} → "inflight"/claimed)
  → process → done | failed(backoff → pending) | dead-letter/manual_review
  + reclaim orphaned inflight rows (crashed-worker recovery via claim TTL)
```

| Worker | File | Interval / batch | Claims | Crash recovery |
|---|---|---|---|---|
| Dispatch fan-out | `modules/booking/utils/dispatchQueue.js` | 1.5 s, 50/batch, 10 concurrent | `pending → inflight` (oldest first) | `inflight` + `claimedAt` > 2 min → requeue |
| Booking broadcast | `modules/booking/utils/bookingOutboxWorker.js` | poll | `pending → inflight` | same lease pattern |
| Notification dispatch | `modules/notifications/utils/notificationWorker.js` | 5 s | `pending` lease + reclaim stale `published` (>2 min) | lease reclaim |
| Payment/refund crons | `modules/payments/utils/paymentCrons.js`, `attemptExpirySweeper.js`, `modules/refunds/utils/refundEngine.js` | 2 m–6 h per job | status + `nextAttemptAt` filters | failed → `manual_review`, never infinite retry |

Why polling instead of change streams / triggers: zero extra infra (works on any Mongo incl. Atlas free tier), every claim is an atomic single-doc update (safe across N API replicas with no distributed lock), and each row carries its own retry state (`attempts`, `nextAttemptAt`, `lastError`). Cost: delivery latency ≈ poll interval (1.5–5 s) — hence the `setImmediate` drain kick after every enqueue in the dispatch queue, which drops hot-path latency to ~0.

### 2.3 Client polling → push migration (the "anti-polling fix")

History visible in code comments: technician apps used to poll the job feed on a timer, and each poll cost "3 queries + 3 populates" (`index.js:335-340` comment, Socket Analysis Fix #5). The replacement:

1. **Server pushes change signals.** Every feed mutation calls `emitJobsChanged(io, techId, …)` (`modules/notifications/utils/sendNotification.js:38`) → `technician:jobs_changed` (+ legacy `jobs_changed`) to `technician_{profileId}` and `user:{userId}` rooms. Emitters: `technicianMatching.js:1222` (broadcast created), `technicianBroadcastController.js:560` (job taken by someone else), revalidation paths (expiry), crons.
2. **A feed cursor makes polls cheap.** Each emit bumps `TechnicianProfile.lastJobsChangeAt`. The `technician:get_jobs` handler (`index.js:335-382`) reads only that one field and compares with the client's `since`:
   - `since >= lastJobsChangeAt` → ack `{unchanged:true}` — no heavy query, no emit, client backs off.
   - otherwise → `fetchTechnicianJobsInternal()` (`modules/technician/utils/technicianJobFetch.js`) + emit `technician:jobs_list` + ack with fresh `latestVersion`.
3. **Correct client behavior** (stated in the handler comment): call `get_jobs` on connect/foreground, then only when a `jobs_changed` push arrives — never on a timer. Rate limit (1 per 3 s per socket) punishes timer-pollers with `throttled:true`.

So in polling taxonomy terms: **push-primary with cursor-polled fallback** — not long-polling, not interval polling.

---

## 3. Dispatch queue (durable fan-out, end-to-end)

Full implementation: `modules/booking/utils/dispatchQueue.js` (203 lines). Queue table: `modules/booking/models/DispatchOutbox.js` (`bookingId, technicianId, kind:"job_new", broadcastId, version, payload, status, attempts, maxAttempts=6, nextAttemptAt, claimedAt` + unique (booking×tech×kind) + 24 h TTL on terminal rows).

```text
matchAndBroadcastBooking()  [same Mongo TX as JobBroadcast rows + booking→broadcasted]
  → enqueueJobNewNotifications() → insertMany(outbox rows, dup-11000 swallowed) + setImmediate drain
  → inline socket emit (fast path; best-effort)
  → worker poll (1.5 s): claim → PRE-SEND GUARD (re-read booking.status; skip unless
     pending/broadcasted → done:booking_<status>) → notifyTechnicianOfNewJob()
     → success done | skip done (no retry burn) | fail → pending+backoff (2^attempts ≤60 s) | ≥6 → failed
```

Design points that matter:

- **Decide vs deliver split**: matching decides recipients; the worker delivers. A crash between them loses nothing (rows are committed).
- **Pre-send guard** (`dispatchQueue.js:64-76`) is what stops alerts for jobs that were cancelled/accepted/expired while queued.
- **Duplicate-safe**: re-broadcasts re-insert the same keys; Mongo unique index collapses them.
- **Bounded**: 50/batch, 10 concurrent — a 500-technician broadcast cannot stampede FCM or Mongo.
- **Operated**: `modules/booking/routes/adminDispatchRoutes.js` (`/api/admin/dispatch/stats|failed|pending|health`, `:id/retry`, `retry-failed`, `worker/restart|stop`).

Sibling queues with the same DNA: `BookingOutbox` (broadcast *decision* after commit), `NotificationOutbox` (generic notify delivery), `PayoutOutbox` (RazorpayX sends), `RefundOutbox` (refund execution), `QuotationDelivery` (quote in_app/WhatsApp).

---

## 4. Socket layer (rooms, events, protocol, budgets)

### 4.1 Connection pipeline (`index.js`)

```text
TCP → handshakeLimiter (20/min/IP, fixed-window, shared/middleware/socketRateLimiter.js)
  → socketAuth (async jwt.verify of handshake.auth.token ONLY — no ?token= query — +
     shared resolveAuthSubject: Deleted/Blocked/Inactive, role-equality, tokenVersion,
     technician ownership + suspended/deleted blocks)
  → room joins + single-session kick + per-socket limiter map + handlers
```

### 4.2 Rooms (`shared/utils/socketConstants.js` → `SOCKET_ROOMS`)

`user:{userId}` (every role) · `role:{role}` · `customer_{userId}` (compat) · `technician:{technicianProfileId}` (ops room — never `user:{profileId}`, the code explicitly guards this confusion) · `admin_dashboard` + `admin` (Owner/Admin feed, replaces old global `new_booking` emit).

### 4.3 Events (`SOCKET_EVENTS`)

| Direction | Event | Payload | Notes |
|---|---|---|---|
| C→S | `technician:location_update` + ack | `{latitude, longitude}` | 12/min per tech (module-scope bucket, reconnect-proof); every drop acked (no silent `socket.use` drops → no client retry storms); validates finite numbers; runs `handleLocationUpdate` |
| C→S | `technician:get_jobs` + ack | `{since?}` (or ack-only call) | 1/3 s per socket; cursor short-circuit (§2.3); emits `technician:jobs_list` only on change |
| S→C | `technician:jobs_list` | jobs array | full feed, only when changed |
| S→C | `technician:jobs_changed` / `jobs_changed` | `{changed, at}` / `{action, bookingId, broadcastId, reasons}` | change signal → client calls `get_jobs` |
| S→C | `job:new` | `toJobNewDTO(booking, broadcast)` (`shared/utils/socketDTO.js` — stable wire shape, never raw Mongoose) | inline fast path + dispatch worker |
| S→C | `job:expired` + `jobs_changed{removed}` | `{bookingId, broadcastId, reason(s)}` | revalidation / availability-change revocation |
| S→C | `session_replaced` | `{message}` | single-session kick before old socket disconnects |
| S→C | customer events (`booking_completed`, `PAYMENT_DUE`, `job_accepted`…) | booking DTOs | via `notifyCustomer…` helpers to `user:{customerId}` |

Presence check is O(1) and synchronous: `hasLiveSocket(io, techId)` reads the adapter's room set (`sendNotification.js:22-32`) — used to decide socket-vs-push routing and socket→push fallback. Metrics: `shared/utils/socketMetrics.js` (location drops, ack records, 60 s logger + `/health/metrics`).

### 4.4 Multi-server note

Redis adapter fans out *emits* across replicas, but presence (`activeSocketByUser`), handshake buckets, location budgets, and per-socket limiters are per-process — documented in code. Past one replica these must move to Redis (see M11 audit). Socket payload cap is 500 KB; connection-state recovery replays 2 min of missed events with middlewares re-run.

---

## 5. Transactional outbox family (all six, compared)

Same DNA everywhere — business rows + event rows commit in **one Mongo transaction**,
a worker delivers later with claim/lease, exponential backoff, and a terminal
failed/`manual_review` state plus a reconciler:

| Outbox | Model | Producer (same TX as…) | Worker | Retry / terminal | Reconciler |
|---|---|---|---|---|---|
| Booking | `booking/models/BookingOutbox.js` | `createBookingAndOutbox`: booking + `booking_created` | `bookingOutboxWorker.js` → `matchAndBroadcastBooking` | backoff, maxAttempts | stuck-`inflight` reclaim via claim TTL |
| Dispatch | `booking/models/DispatchOutbox.js` | matching TX: `JobBroadcast` rows + booking→broadcasted + `job_new` per tech | `dispatchQueue.js` (1.5 s, 50/batch, 10 conc.) | backoff `2^attempts` ≤60 s ×6 → `failed` | `inflight`+`claimedAt`>2 min requeue; admin retry routes |
| Notification | `notifications/models/NotificationOutbox.js` | `notify()`: `Notification` + `Delivery` rows + outbox | `notificationWorker.js` (5 s) + stale-`published` reclaim >2 min | per-`CHANNEL_POLICY` retries → `completed`/`dead_letter` | metrics + `/health/metrics` |
| Payout | `payouts/models/PayoutOutbox.js` | withdrawal engine: reserve + `WithdrawalRequest` + `initiated` (idempotent on withdrawal id) | `withdrawalPayoutEngine.js` + `paymentCrons` 10-min payout reconcile | timeout → `manual_review` | `reconcileStuckPayouts`, daily ledger audit |
| Refund | `refunds/models/RefundOutbox.js` | `createRefund`: reservation + clawback + ledger×4 + credit-note + `new` | `refundEngine.refundWorker` (30 s, batch 25) | backoff → `failed` + `reverseClawback` + reservation revert | `reconcileRefunds` (5 m) |
| QuotationDelivery | `quote-product/models/QuotationDelivery.js` | quote send/resend/accept TX: `enqueueDeliveries` (unique triple) | `quotationDeliveryService.processQuotationDeliveries` (30 s) | channel retry; parent never flips on failure | `expireQuotations` (1 h) |

Rule of thumb for new features: if the effect leaves the process (push, SMS, money movement,
provider call), it goes behind an outbox row in the same transaction — never inline after commit.

## 6. Matching & broadcast fan-out (one booking → N technicians → one winner)

`modules/booking/utils/technicianMatching.js` + `technician/controllers/technicianBroadcastController.js`
(respond/claim) + `modules/technician/utils/technicianEligibility.js` + `technicianLocation.js`
(revalidation):

```text
matchAndBroadcastBooking(booking) [lease-claimed, multi-instance safe]
  → findEligibleTechniciansForService: approved + online + skilled + not-busy +
     GPS fresh (locationUpdatedAt ≤ STALENESS_SECONDS) + district/zone permission +
     10 km $nearSphere + Haversine + polygon + feasibility + availability resolver
  → upsertTechnicianOffers (funnel audit) → ONE TX:
     JobBroadcast(sent, version) × N  +  booking→broadcasted + activeBroadcastVersion++
     + DispatchOutbox(job_new) × N
  → lastJobsChangeAt bump × N + emitJobsChanged × N + inline job:new + worker fan-out
Technician GET my-jobs (online + no conflicting active job + activated)
  → PUT respond {accept, version}: sent + unexpired + version match + ACCEPT-eligibility
     + travel feasibility + dispatch mutex
  → ATOMIC findOneAndUpdate({_id, status ∈ [pending,broadcasted], technicianId:null})
     → accepted + assignedAt + snapshot  (exactly one winner under any storm)
  → winner Broadcast/Offer accepted; losers expired/superseded + jobs_changed{removed}
  → notifyCustomerJobAccepted + notifyJobTaken
Movement/availability/permission changes → revalidateActiveBroadcasts() expires stale offers.
```

Live counters: `broadcastMetrics.js`; per-row trace logs with `traceId`.

## 7. Geo-fence resolution (GPS → jurisdiction → availability)

`modules/geo/utils/resolveZoneFromCoordinates.js` + `modules/geo/services/districtService.js` +
`modules/geo/services/serviceAvailabilityService.js` (single source of truth):

```text
GPS (booking address | tech registration | live ping)
  → $geoIntersects on CityZone polygons → zone (+operationalCityId)
  → fallback $geoIntersects on OperationalCity polygons → district
  → resolveServiceAvailability(): Service.isActive
      > district active/job flags > zone exists/belongs/active
      > ZoneServiceMapping mandatory > ZONE/CITY override > DISTRICT default > fallback
  → ALLOW or BLOCK with reason (inactive / mismatch / missing mapping)
```

Consumers: checkout + listing filter (cart-address, catalog), booking create + matching (booking),
tech registration + `zoneMismatch` flag on pings (technician). Polygons are versioned
(`PolygonVersion` + rollback); MultiPolygon-safe via Mixed storage + controller validation.

## 8. Money pipeline (collect → hold → settle → pay out → refund)

Paise integers are truth; `financialSnapshot` copies are immutable; `PlatformLedgerEntry`
(`modules/payouts/models/…`) is append-only platform truth:

```text
IN  (payments): initiate copies booking snapshot → Payment(pending) + Razorpay order
      → verify (HMAC fast path) / webhook payment.captured (authoritative;
        PaymentEvent eventId dedupe; captured-vs-total guard → manual_review)
      → markPaymentSucceeded TX: ledger(customer_payment + liability + commission)
        + booking paid + Receipt  [variants: ₹0 free, admin offline (maker+checker), override]
HOLD→SETTLE (payouts): completed+paid+success+snapshot-match
      → WalletTransaction credits job:<id>/tip:<id> (unique) + dues-first recovery
        + technician_earning_liability  [retry + 15-min backstop]
OUT (payouts): requestWithdrawal (KYC-bank/floor/dues/complaint/cooldown gates;
        available→reserved + debit + request in TX)
      → engine re-gates → PayoutOutbox(initiated) → RazorpayX contact/fund/payout
      → webhook: paid (release + lifetime + technician_payout ledger) | failed (reserve
        refund) | timeout (manual_review)  [admin dual-approval ≥₹10k; autoPayout 6h]
BACK (refunds): preview (net/clawback/commission/MDR/fee/GST math) → createRefund TX:
        amountRefundedPaise reservation + clawback cascade
        (ReserveHold → reserve/available → outstandingDues) + 4 ledger lines + CreditNote
        + RefundOutbox → worker executes rail (reverse | X payout) → webhook finalize;
        failure → reverseClawback + revert. Disputes → Chargeback; mismatches →
        ReconciliationException. Complaint holds via ReserveHold + BookingPayoutBlock.
```

## 9. Notification fan-out (one event, many channels, independent fates)

`modules/notifications/services/notificationService.js` (`notify()`, never throws) +
`unifiedNotificationService.js` (legacy immediate path) + `notificationWorker/adapters/templates` +
`firebase/sendSMS/sendWhatsapp/sendMail` + `NotificationPreference` + `DeviceToken`:

```text
notify({eventType, recipientId/Type, data, source}) → event allowlist + idempotencyKey check
  → template render (~30 events) → channel filter (ENABLED_CHANNELS + push-permission + DND delay)
  → TX: Notification + NotificationDelivery per channel + NotificationOutbox(pending)
  → worker lease → adapters: socket io.to(room).emit | FCM multicast (prune not-registered)
    | Fast2SMS (OTP) | Twilio WA (quotes) | mail (reserved)
  → per-channel sent/failed → completed | dead_letter + metrics
Reads: user inbox (cursor list, unread, read/read-all/received/opened) + admin badges
  (QuoteRequest/Profile/Report isRead counts + admin:unread_counts_updated push).
```

## 10. OTP → JWT sessions (identity concept every module relies on)

Full reference: `docs/Role-Profiles-And-Authentication-Flows.md`. In one paragraph:
CSPRNG OTP (bcrypt, 5-min TTL, 5 attempts, SIGNUP vs LOGIN purposes) proves phone ownership;
verify-signup creates `User` (+`TechnicianProfile`) in one transaction and signs an HS256 JWT
(7d, `{userId, role, technicianProfileId?}`); every HTTP request and socket handshake re-resolves
the subject from the DB (`resolveAuthSubject`: status, role-equality, compat-window tokenVersion,
technician ownership + suspended/deleted blocks); roles fan out via `authorizeRoles`,
`isTechnician` (lean + liveness), `ensureCustomer`; one live socket per user (single-session kick).

## 11. Cron sweeps & expiry (time-driven transitions)

| Sweep | File | Cadence | Does |
|---|---|---|---|
| Booking expiry/rebroadcast/OTW-timeout/enforcement/reminders/orphan cleanup | `booking/utils/bookingCron.js` | 1–30 m per job | `autoCancelAt` → expired/cancelled; 2× release-then-cancel OTW; h24/h1/m15 reminders |
| Attempt expiry | `payments/utils/attemptExpirySweeper.js` | continuous | stale `PaymentAttempt` → expired (new order allowed) |
| Payment/payout reconcile + ledger audit | `payments/utils/paymentCrons.js` | 15 m / 10 m / 6 h auto-payout / daily | heal stuck payments/payouts; threshold auto-payout; ledger audit |
| Refund worker/reconcile/ClassA scan/SLA/freeze expiry | `refunds/utils/refundEngine.js`, `complaintFreeze.js` | 30 s / 5 m / 2 m / 1 h / 15 m | execute + finalize + auto-qualifying refunds + escalate + release holds |
| Quotation delivery + expiry | `quote-product/services/quotationDeliveryService.js`, `quotationService` | 30 s / 1 h | send in_app/WhatsApp; expire stale quotes |
| Notification worker | `notifications/utils/notificationWorker.js` | 5 s | lease + dispatch + dead-letter |

All sweeps are batched, lease/condition-guarded (multi-instance safe), and never retry `manual_review`
(human queue) automatically.

## 12. Idempotency / exactly-once patterns (used everywhere)

| Mechanism | Where | Example |
|---|---|---|
| `idempotencyKey` unique | Payment, WalletTransaction (`job:<id>`, `withdrawal:<id>`), Refund, PayoutOutbox, Notification | double-settle / double-refund / double-notify collapse |
| Conditional status update | dispatch claim, accept claim, webhook apply, outbox leases | `findOneAndUpdate({status:expected} → next)`; loser gets 409, never double effect |
| `version` optimistic concurrency | booking status steps (`version` CAS), polygon edits, settings | stale writer loses, refetches |
| Unique natural pairs | (booking×tech×kind) dispatch, (request×sent/viewed) quote lock, (customer×product) thread, (user+device) token | re-broadcast / re-accept / re-register are no-ops |
| Webhook dedupe | `PaymentEvent.eventId` unique, provider payout/refund ids unique | provider retries → 200 deduped |
| OTP consume | `verified:false→true` + delete | replay → 409 already-consumed |

## 13. Audit trail (who changed what, when)

`support-system/models/AuditLog.js` (append-only: actor/action/target/before/after/reason/metadata)
via never-throws `shared/utils/audit.js` `writeAuditLog()` — called on money moves, status transitions,
KYC decisions, permission grants, settings changes. Queried by `productDashboardController`
(admin audit-log reads). Retention: no TTL (legal hold; archive cold, don't delete).

## 14. End-to-end trace (all concepts on one booking)

```text
Customer POST /booking/schedule
  → bookingService.build + createBookingAndOutbox TX {ServiceBooking(pending) + BookingOutbox}
  → BookingOutbox WORKER POLL claims row → matchAndBroadcastBooking()
      → eligibility filter (approved/online/skilled/fresh-GPS/permission/zone/10 km/polygon)
      → TX {JobBroadcast(sent)×N + booking→broadcasted + DispatchOutbox(job_new)×N}
      → lastJobsChangeAt bump ×N + emitJobsChanged ×N ............ PUSH (concept: push, §2.3)
      → inline job:new emit (best-effort)
  → DISPATCH WORKER POLL claims rows .................. POLL LOOP (concept: worker poll, §2.2)
      → pre-send guard → notifyTechnicianOfNewJob() → socket job:new + FCM
      → done | backoff-retry | failed ................. QUEUE (concept: dispatch, §3)
Tech app (socket connected, rooms joined) ............. SOCKET (concept: socket, §4)
  → receives jobs_changed → get_jobs{since} → unchanged? back off : jobs_list
  → PUT /job-broadcast/respond accept → atomic claim (one winner)
  → losers: Broadcast expired + jobs_changed{removed} → their feeds refresh
  → status steps → completed → settlement → PAYMENT_DUE push → customer pays
```

Failure branches: worker crash → lease reclaim redelivers; FCM down → socket still delivers + worker retries push; booking cancelled mid-queue → pre-send guard drops rows; tech offline → FCM only, feed catches up via `since` cursor on reconnect; duplicate webhook/poll → idempotency keys + unique indexes collapse them. Money legs add their own: webhook loss → reconciler heals; payout timeout → `manual_review` queue; refund failure → clawback reversal; every leg audited.

---

## 15. Module × concept matrix (all concepts)

| Module | Poll worker | Push/cursor | Outbox | Matching/geo | Money | Notify | Auth/session | Sweeps | Audit emit |
|---|---|---|---|---|---|---|---|---|---|
| M1 identity | — | — | — | — | — | triggers | **owns** OTP/JWT/gates | — | admin acts |
| M2 technician | — | `get_jobs` contract, `fetchTechnicianJobsInternal` | — | eligibility input, revalidation, mismatch | — | triggers | gated | — | — |
| M3 geo | — | — | — | **owns** resolver + permissions + availability | — | — | permission routes | — | grants/polygons |
| M4 catalog | — | listing filter (via M3) | — | snapshot source | — | — | — | — | — |
| M5 cart/address | — | zone/slot gates at add + checkout | — (delegates to M6/M7 TXNs) | resolve location | — | — | gated | — | — |
| M6 booking | outbox worker, cron sweeps | `emitJobsChanged`, `lastJobsChangeAt` | **owns** Booking + Dispatch | **owns** matching/broadcast/claim | — | triggers | gated | autoCancel/remind/OTW | status acts |
| M7 quote/product | delivery worker, expiry | quote pushes | QuotationDelivery | — | — | triggers | gated | expiry | — |
| M8 payments | sweeper, reconcile, notify worker | payment pushes | (reads committed state; no own outbox) | — | **owns** collect | triggers | gated | reconcile/backstop | overrides |
| M9 payouts | reconcile, auto-payout, ledger audit | payout pushes | PayoutOutbox + engine | — | **owns** settle/pay | triggers | gated | reconcile/audit | approvals |
| M10 refunds | refund worker, reconcile, ClassA, SLA, freeze expiry | refund pushes | RefundOutbox | — | **owns** refund/clawback | triggers | gated | reconcile/escalate | decisions |
| M11 notifications | notification worker (5 s) | **owns** push/cursor/socket/FCM | NotificationOutbox | — | — | **owns** fan-out | socketAuth gate | — | badge reads |
| M12 support/system | (uses M10 crons) | badge pushes | — | — | triggers M10 | triggers | gated | (SLA via M10) | **owns** store + dashboard |

---

## 16. Related documents

- `docs/BACKEND_MODULES_RESPONSIBILITIES.md` — full module/file inventory (§M6 dispatch, §M11 realtime).
- `docs/module-audits/` — M6 (dispatch + broadcast), M11 (notification/socket), M2 (location tracking), M9/M10 (payout/refund outboxes).
- `modules/README.md` — folder layout + layer rules.
