# M11 — Notifications / Realtime / Devices: Production Audit & Rewrite Design

> Project: RightTouch · Stack: Express 5 + Socket.IO 4 (+ Redis adapter) + FCM + Fast2SMS + Twilio + Nodemailer(reserved)
> Scope: ONLY M11. Message content triggers live in other modules; M11 owns delivery.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M11 delivers `notify({eventType,recipient,data,source})` → template render → preference/DND/permission gate → `Notification + Delivery + Outbox(pending)` → 5s worker lease → per-channel dispatch (socket→`io.to(room).emit` | push→FCM | sms→Fast2SMS; whatsapp/email stubbed), with a parallel fast path (`unifiedNotificationService/sendNotification.js` direct emit + background FCM), an isolated quotation outbox (`QuotationDelivery` + 30s worker), user inbox + admin badges, `DeviceToken` registry (shadowing legacy `User/TechnicianProfile.fcmTokens`), and socket runtime (handshake limiter → socketAuth → rooms → single-session kick → acked location/get_jobs handlers). Delivery works, but tokens live in 3 places, presence/rate state is per-process (breaks at ≥2 replicas — code itself warns), the fast path bypasses outbox durability, and `QuotationDelivery` duplicates the generic pattern. Verdict: **YES WITH CONDITIONS** — unify token store, route all durable notifications through outbox, move presence/buckets to Redis before scaling past 1 replica.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/Notification.js` | Inbox record + read/received/opened + idempotencyKey unique | notify(), unified path, quotation in_app | — | YES | REMAIN, add refPath |
| `Schemas/NotificationOutbox.js` | pending→published→completed\|failed + lease | notify() | — | YES | REMAIN (sole durable path) |
| `Schemas/NotificationDelivery.js` | (notification,channel) unique per-channel attempts | notify(), worker | — | YES | REMAIN |
| `Schemas/NotificationPreference.js` | Per-user channel/category/DND/lang | notify() gate | — | YES | REMAIN |
| `Schemas/DeviceToken.js` | user+device unique FCM registry (syncs legacy mirrors) | deviceRoutes, sendPushNotification | — | YES (make sole) | REMAIN, delete mirrors (M1/M2) |
| `Schemas/QuotationDelivery.js` | (quotation,channel,type) unique outbox | quotationDeliveryService | — | YES | REMAIN (merge later, not now) |
| `Services/notificationService.js` | Central notify() (validate→idempotency→template→gates→create triple; never throws) | all modules | templates, prefs, outbox | YES (keep!) | REMAIN untouched |
| `Services/unifiedNotificationService.js` | Legacy immediate sendAppNotification (direct create + instant emit + bg push) | older call sites | io, FCM | PARTIAL (bypasses outbox) | MERGE into notify(fast-lane flag) |
| `Services/quotationDeliveryService.js` | enqueueDeliveries(TX) + processQuotationDeliveries + recordProviderCallback | M7 send/resend/accept + cron | Notification, Twilio | YES | REMAIN |
| `Utils/notificationWorker.js` | 5s lease + reclaim stale published(>2m) + dispatchByChannel + retry/backoff + dead_letter | startBackgroundWorkers | adapters | YES | REMAIN |
| `Utils/notificationTemplates.js` | renderTemplate(~30 events) | notify() | — | YES | REMAIN |
| `Utils/notificationAdapters.js` | socket/push/OTP-sms dispatch; wa/email stubbed | worker | io, FCM, Fast2SMS | YES | REMAIN, document stubs |
| `Utils/sendNotification.js` | Hot-path realtime+push (hasLiveSocket, notifyTechnicianOfNewJob + Redis dedupe, broadcast, customerAccepted, sendPush + prune, batch, socket→push fallback) | matching, booking flows | io, FCM, redisDedupe | YES (hot path) | REMAIN, route durable copy via notify() |
| `Utils/firebase.js` | Lazy FCM singleton + multicast; missing creds → skipped | push adapter | FCM | YES | REMAIN |
| `Utils/sendSMS.js` / `sendWhatsapp.js` / `sendMail.js` | Fast2SMS OTP / Twilio OTP / Nodemailer reserved | OTP + quotation WA | providers | YES | REMAIN |
| `Utils/notificationMetrics.js` | Dispatch metrics (/health/metrics) | worker, health | — | YES | REMAIN, extend (per-channel, drop rate) |
| `config/notificationEvents.js` | Event policy (channels/priority/category/dnd/socketEvent/recipientTypes) | notify() | — | YES | REMAIN |
| `Controllers/notificationController.js` | Inbox list/unread/read-all/received/opened (role-scoped) | notificationRoutes | Notification | YES | REMAIN, cursor pagination |
| `Controllers/adminNotificationController.js` | Admin badges (isRead≠true counts) + mark-read + broadcastAdminUnreadCounts→admin_dashboard | same + signup/complaint hooks | QuoteRequest, Profile, Report | YES | REMAIN |
| `Routes/notificationRoutes.js` (×3) + `deviceRoutes.js` (×2) | inbox + badges + token register/unregister | index.js | controllers, permissionService | YES | REMAIN |
| Socket runtime | socketAuth + socketRateLimiter + ioAccess + socketConstants/DTO/Metrics/SessionControl + index.js handlers | index.js | — | YES | REMAIN, Redis-back presence |

## 3. Actual Current Flow

```text
Durable: notify({eventType,recipientId/Type,data,source}) → isValidEventType + idempotency findOne
 → preference + renderTemplate → filter ENABLED_CHANNELS + push-permission gate + DND delay
 → Notification.create + Delivery.insertMany + Outbox.create(pending)
 → worker.tick leases pending (+reclaim stale published>2m) → dispatchByChannel(socket→emit|push→FCM|sms→Fast2SMS)
   with CHANNEL_POLICY retries → completed | dead_letter (exhausted)
Fast: sendAppNotification()/sendNotification.* → direct Notification.create + io.to(room).emit + bg FCM (no outbox)
Quotation: enqueueDeliveries(TXN) → 30s cron → in_app→Notification | whatsapp→Twilio → recordProviderCallback
Reads: inbox cursor list + unread + read/read-all/received/opened; admin badges + admin:unread_counts_updated push
Sockets: handshakeLimiter(20/min) → socketAuth → joins(user:/role:/customer_/technician_/admin_dashboard)
 → single-session kick (old socket SESSION_REPLACED + disconnect) → TECH_LOCATION_UPDATE (12/min acked)
 → TECH_GET_JOBS (1/3s + since≥lastJobsChangeAt short-circuit) → jobs list emit + ack
```

Failure: FCM down → push fails → retry/backoff → dead_letter (socket may have delivered — per-channel independence good). Retry: worker retries per CHANNEL_POLICY. Timeout: lease expiry → reclaim. Cancel: N/A (notifications aren't cancellable; job-cancel uses M6 revoke — wire here). Dup: idempotencyKey + Redis dedupe (tech job push). Concurrent: dual-worker claim via lease (verify atomic). Partial: channel-independent success (good). Admin: badge counts + mark-read.

## 4. Business Rules & Invariants

1. **A notification never creates business/financial effects (side-effect free).** Enforcement: notify() writes only M11 docs (verify no caller depends on notify success — it never throws, good). KEEP + test (notify down → business flow unaffected).
2. **Durable notifications survive worker crash (outbox + lease).** Enforcement: outbox path only. Fail: fast path bypasses. Solution: fast path = emit hint + durable notify() (both: instant UX + durability).
3. **One logical event → one inbox row (idempotent).** Enforcement: idempotencyKey (good). KEEP + require key on all business triggers.
4. **Per-channel fate is independent (socket delivered ≠ push delivered).** Enforcement: Delivery rows (good). KEEP.
5. **Token registry has ONE writer (DeviceToken).** Enforcement: BROKEN (3 stores). Fix §18.
6. **Presence/rate state must be shared across replicas before scale-out.** Current: per-process (works at 1 replica). Fix: Redis before 2nd replica.

## 5. Current Problems

- **P0 — Per-process presence/rate maps (single-session kick + socket budgets multiply by N replicas).** Evidence: index.js comments warn explicitly. Impact: duplicate job alerts at scale. Fix: Redis presence (`activeSocketByUser` → Redis SET NX + TTL + pub/sub kick) + Redis token-bucket for budgets BEFORE adding 2nd replica. Until then: document single-replica constraint.
- **P1 — Fast path bypasses durability (lost on crash between create and emit).** Fix: fast emit + durable notify() together (emit is hint; inbox/worker is truth).
- **P1 — Triple token stores (User/Profile/DeviceToken) + prune only sometimes.** Fix: DeviceToken sole store; prune on FCM not-registered (exists — extend to all paths); drop mirrors (M1/M2 joint).
- **P2 — QuotationDelivery duplicates generic outbox.** Fix: keep separate for now (WhatsApp threading differs); share lease/retry helper; merge only if justified later.
- **P2 — whatsapp/email adapters stubbed but events may request them.** Fix: policy must never route to stubbed channels (audit config; fail closed with alert).
- **P3 — `recipientId` untyped (no refPath).** Fix: add recipientModel enum + refPath.

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P1 | Socket room confusion (user:{techProfileId} wrong-room bug class) | mis-emit to wrong user | code has explicit guards/comments | leak/miss | keep guards + room-verify health endpoint (exists) + test | /health/socket-rooms test |
| P1 | Handshake token via query (historical)? | token in URL logs | auth.token-only (good) | — | KEEP + test query ignored | test |
| P2 | FCM token hijack (register other's token) | B registers A's token | Auth-bound userId (good) | misdirected pushes | KEEP + deviceId binding | test |
| P2 | Push content PII in notification body | lock-screen leak | templates include names? review | privacy | minimize push body + full text in-app only | template audit |
| P2 | SMS OTP cost abuse | trigger OTP events rapidly | OTP sms path rate-limited? verify | cost | per-recipient OTP throttle (Redis) | throttle test |

## 7. Database Findings

Notification: ADD recipientModel refPath + `{recipientId,recipientType,createdAt:-1}` (exists ✓ per schema — verify) + `{recipientId,readAt,createdAt}` (exists ✓). Outbox: ADD `{status,nextAttemptAt}` claim index (verify present; add if missing). Delivery: KEEP unique pair + ADD `{status,nextAttemptAt}`. Preference: KEEP `{userId}` unique. DeviceToken: KEEP unique(user,device) + ADD `{updatedAt}` TTL? No — explicit unregister + prune; ADD `{userId}` index. QuotationDelivery: KEEP unique triple. Bound growth: ADD TTL/archive for read old notifications (e.g. 90d, product call).

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| worker claim | NEW/verify {status,nextAttemptAt} | batch + lease atomic |
| inbox list | {recipientId,recipientType,createdAt desc} ✓ + cursor (not skip) | keyset pagination |
| unread count | {recipientId,readAt} partial unread ✓ | countDocuments (fast) |
| dedupe check | idempotencyKey unique sparse ✓ | single read |
| token gather (push) | {userId} NEW | single $in multicast |
| admin badges | isRead≠true counts on 3 collections | cache 5s? (only if slow — measure; keep live first) |

## 9. Concurrency Findings

- Dual-worker outbox claim: lease atomic `findOneAndUpdate({status:pending or (published + lease expired)}, {published, leaseOwner, leaseUntil})` — VERIFY atomicity; no Redis needed (DB lease suffices).
- Duplicate notify same key: unique backstop → catch → return existing (add).
- Token register race: upsert (good).
- Single-session kick race across replicas: per-process only → Redis SET NX solution (§5 P0).

## 10. Transaction Findings

- notify() triple-create (Notification + Deliveries + Outbox): ONE txn (verify; add if separate — REQUIRED for durability guarantee).
- recordProviderCallback: single update (no txn). markRead paths: single updates (no txn). Token register: upsert (no txn).

## 11. Outbox / Worker Findings

Worker correct (lease + reclaim + backoff + dead_letter). Verify: backoff curve, maxAttempts, lease TTL (2m reclaim) vs 5s interval, poison handling (dead_letter + alert — verify alert exists; add if missing). Missing: `cancel_revoke` dispatch kind for M6 (ADD kind + tech-offline catch-up on reconnect: on `TECH_GET_JOBS`/reconnect, also deliver pending revokes — design with M6). Quotation worker same pattern (30s) — verify same lease hygiene.

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| notify | idempotencyKey unique | replay → return existing 200 |
| worker dispatch | claim lease + per-channel delivered flags | redelivery after crash → channel-skips-delivered (verify flags) |
| push send | FCM message id? (provider-side dedupe limited) | at-least-once push acceptable (inbox is truth) — document |
| sms OTP | per-OTP row | replay same OTP → same code window (acceptable) |
| markRead | idempotent flags | replay 200 |

## 13. API Contract Findings

Inbox: cursor pagination (`?after=createdAt_id&limit=`) — verify current is cursor (controller says cursor — keep; else migrate from skip). `received/opened` telemetry POSTs — keep. Admin badges: `GET /unread-counts` + `PATCH /mark-read` — keep. Device: POST/DELETE `/device-token` — keep + require deviceId + platform. No versioning needed (additive).

## 14. Target Architecture

```text
Trigger (any module) → notify() [validate→idempotency→template→gates→TXN triple] → Outbox
 → Worker (lease) → Adapters (socket|push|sms) → Delivery flags → completed|dead_letter
Fast path: emit hint (socket, best-effort) + notify() durable (both, always)
Sockets: handshakeLimiter(Redis P2) → socketAuth → rooms → handlers (location/jobs) with Redis budgets (P2)
```

## 15. Target Schema

KEEP all; ADD refPath + claim indexes + userId token index; PLAN TTL/archive for old inbox rows (product decision); mirrors deleted in M1/M2 (this module reads DeviceToken only).

## 16. Target Query Design

Claim-batched worker; keyset inbox; unique-dedupe reads; token multicast batched; badge counts measured before caching; all explain-verified.

## 17. Target File Structure

```text
modules/notifications/
├── routes/inbox.routes.js | admin-badges.routes.js | device.routes.js (same paths)
├── controllers/* (thin)
├── services/notify.service.js (frozen) | inbox.service.js | quotation-delivery.service.js (keep)
├── domain/channels.policy.js  # NEW extracted CHANNEL_POLICY (single place)
├── adapters/socket|push|sms.adapter.js (split, same logic)
├── repositories/*.repo.js
├── validators/notify.validator.js # NEW (event allowlist)
├── workers/notification.worker.js (moved, same logic + lease verify)
└── tests/...
```

## 18. State Machine

```text
Outbox: pending → published → completed | failed → dead_letter (terminal; alert)
Delivery (per channel): pending → sent | failed→(retry)→sent | dead (terminal per channel)
Notification (inbox): unread → read (terminal) + received/opened telemetry orthogonal
Socket session: connected → replaced|disconnected (terminal per socket)
```

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Worker crash mid-dispatch | lease reclaim → redeliver pending channels only | ? flags | verify + test |
| FCM invalid token | prune + continue other tokens | prune exists | KEEP + test |
| No FCM creds (dev) | skipped:true, socket still | exists | KEEP |
| DND quiet hours | delay, not drop | delay exists | KEEP + test |
| Stubbed channel requested | fail closed + alert | ? | audit config |
| Second replica added | shared presence required | per-process | Redis gate (P0 pre-scale) |
| Offline tech job-cancel | revoke on reconnect | lost | ADD cancel_revoke (M6 joint) |
| Duplicate event storm | one inbox row | unique (good) | KEEP + test |

## 20. Test Plan

Unit (template render × events, gates, CHANNEL_POLICY); integration (notify TXN triple, claim→dispatch→flags); API (inbox cursor, badges, device register, role scoping); concurrency (dual-worker claim, duplicate notify storm → one row); idempotency (replay table); security (room isolation, token binding, push-PII audit); failure (FCM/SMS down → retry→dead_letter + alert; Mongo down → triggers unaffected? notify must never throw — test caller flows); regression (event names + room names pinned); load (10k pending backlog drain time; inbox p95 — measure).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (event/room names, inbox shape). P3 additive indexes background. P4 notify-TXN verify/fix + fast-path-also-notify + dedupe-catch + channel-policy audit (same routes). P5 token-mirror cutover (dual-write one release with M1/M2, then read DeviceToken only). P6 Redis presence/budgets (BEFORE replica #2; flag-gated). P7 cancel_revoke kind + reconnect catch-up (with M6). P8 monitor (dispatch lag, per-channel success, dead_letter, drop rate). Rollback: redeploy; additive until mirror-drop (backup).

## 22. Production Verification Checklist

Code (sole notify path, no business effects, no direct outbox writes outside notify); DB (uniques/claim-indexes/explain/cursor pagination); Security (rooms, token binding, push-PII, throttles); Reliability (TXN triple, lease+reclaim, retry+dead_letter+alert, crash recovery tested); Observability (per-channel metrics, lag, drops, audit on admin mark-read); Tests green; Deployment (background indexes, single-replica constraint documented until Redis lands, rollback).

## 23-26. Files

- Create: domain/channels.policy.js, validators, repos, tests, Redis-presence module (P6).
- Modify: notify (TXN verify), unified path (merge to hint+durable), worker (lease verify + alert), adapters (stub audit), controllers (cursor verify), config (stub-route audit).
- Merge: unifiedNotificationService INTO notify fast-lane (keep export as shim one release).
- Delete: legacy fcmTokens sync code (post-cutover, M1/M2 joint); stubbed-channel routes (if any caller found — else keep stubs unrouted).

## 27. Risks / Open Questions

Inbox retention/TTL (90d?) — product call. WhatsApp/email GA — provider decision (stubs today). Redis timeline vs replica-2 need — SRE gate (DO NOT scale horizontally until P0 lands). Cross-module: ALL modules trigger notify (contract frozen: event names + payload shapes); M6 (job fan-out + revoke — joint); M7 (quotation deliveries — keep isolated); M8/M9/M10 (status pushes); M12 (badges + complaint pushes); M1/M2 (token mirror cutover — joint).

## 28. Final Acceptance Criteria

Single durable path; crash-safe redelivery (channels independently); no duplicate inbox rows under storm; tokens single-sourced; rooms isolated; stubbed channels unreachable; worker lag + dead_letter monitored; tests green.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: notify-TXN + dedupe + fast-path-also-durable in one release with storm tests; token cutover dual-write first; Redis presence BEFORE any horizontal scale (hard gate). Must NOT break: every module's notify() contract (event names/payloads), socket room/event names (mobile pins), inbox shapes, M7 delivery flow.
