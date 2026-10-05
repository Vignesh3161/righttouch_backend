# M6 — Service Booking & Dispatch: Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8 · Realtime: Socket.IO · Workers: outbox + dispatch + crons
> Scope: ONLY M6 (core job lifecycle). Cross-module notes under §27.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M6 is the platform core: `ServiceBooking` (5 parallel machines: status/assignment/cancellation/fee/payment/settlement + bookingType) → `createBookingAndOutbox` TX → `matchAndBroadcastBooking` (eligible-tech filter: approved/online/skilled/not-busy/fresh-GPS + district/zone/skill + 10km + polygon + feasibility) → `JobBroadcast` + `DispatchOutbox(job_new)` → socket+FCM (worker retries) → atomic accept claim → linear execution → complete → settle → pay. Two creation pipelines exist (new TX+outbox vs legacy direct-create), skip-steps allow `accepted→completed` in one call, customer-cancel excludes `in_progress` while the table allows it, and tech-cancel re-dispatch leaves dirty flags. Verdict: **YES WITH CONDITIONS** — unify the pipeline, linearize transitions, fix cancel semantics, all writers through one transition module, in a single release with shadow comparison.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/ServiceBooking.js` | Canonical aggregate (≈115 fields; see responsibilities doc) + pre-save normalize legacy statuses | bookingService, controllers, matching, settlement | Service, User, TechnicianProfile, zones | YES | REMAIN, fix bookingType + vocab |
| `Schemas/BookingOutbox.js` | booking_created TX outbox | bookingService | — | YES | REMAIN, add cancelled/completed/expired events OR document single-event scope |
| `Schemas/DispatchOutbox.js` | per-(booking×tech) job_new fan-out + claim TTL + dedupe + 24h TTL | matching | — | YES | REMAIN, add cancel_revoke kind |
| `Schemas/TechnicianBroadcast.js` | per-tech offer row unique(pair) + version + expiresAt TTL | matching, respondToJob | — | YES | REMAIN |
| `Schemas/TechnicianBookingOffer.js` | Funnel audit (distance/feasibility/latency) | matching | — | YES | REMAIN |
| `Controllers/serviceBookController.js` | createBooking (legacy inline) / storeBookingSchedule (txn), reads, cancelBooking (+fee), deletes, Owner reads, updateBookingStatus (canTransition + version CAS), work images, tech job lists/history, technicianCancelBooking (₹200), acceptCancelledJob | Routes/User.js + technician.js | bookingService, bookingStatus, settlement, wallet | PARTIAL (two pipelines) | SPLIT; delete legacy body |
| `Controllers/bookAgainController.js` | getCompletedServices + rebookService (live price + shared pipeline) | Routes/User.js | bookingService | YES | REMAIN, fix scheduled\|\|schedule checks |
| `Controllers/technicianBroadcastController.js` | getMyJobs (gates) + respondToJob (atomic claim, winner/loser fan-out) | Routes/technician.js | matching, eligibility, notify | YES | REMAIN, tighten guards |
| `Utils/bookingService.js` | buildServiceBookingDoc/createBookingAndOutbox/broadcastCreatedBooking/processBookingCreatedOutbox + resolvers | checkout, schedule, book-again | geo, commission, outbox, matching | YES (keep!) | REMAIN untouched (pipeline standard) |
| `Utils/bookingStatus.js` | normalize/canTransition/isTerminal + BOOKING_TRANSITIONS | all writers (should be) | — | YES (keep!) | REMAIN, remove skip-jumps |
| `Utils/technicianMatching.js` | findEligible/matchAndBroadcast/broadcastPending/upsertOffers/loadCommittedQueues/evaluateFeasibility | pipeline, rebroadcast, reaccept | eligibility, geo, availability, outbox | YES | REMAIN |
| `Utils/dispatchQueue.js` | DispatchOutbox worker (50/10/1.5s) + pre-send state check | startBackgroundWorkers | sendNotification | YES | REMAIN, add revoke kind |
| `Utils/bookingOutboxWorker.js` | BookingOutbox claim-poll → matchAndBroadcast | startBackgroundWorkers | matching | YES | REMAIN |
| `Utils/bookingCron.js` | expiry/rebroadcast/OTW-timeout/enforcement/reminders/orphan-cleanup | startBackgroundWorkers | bookings, notify | YES | REMAIN, route all writes via canTransition |
| `Routes/technician.js` job subset + `Routes/User.js` booking subset + `adminDispatchRoutes.js` | job/booking HTTP + dispatch ops | index.js | controllers | YES | REMAIN, fix guards (jobs/current etc. need role scoping) |

No M6-owned validators (add), no M6 tests (add).

## 3. Actual Current Flow

```text
Create: resolveUserLocation + resolveServiceZoneAvailability + resolveScheduleInput/validateSlot
 → resolveCommissionSnapshot → buildServiceBookingDoc(pending/unassigned, version 1, autoCancelAt)
 → createBookingAndOutbox{ServiceBooking + BookingOutbox TX} → after commit broadcastCreatedBooking
 → matchAndBroadcastBooking(lease-claim): eligible filter → TX{JobBroadcast(sent)×N + booking→broadcasted
 + activeBroadcastVersion++ + DispatchOutbox(job_new)×N} → inline socket + worker FCM retries
 [LEGACY createBooking: ServiceBooking.create alone → matchAndBroadcast direct — NO outbox row]
Accept: GET my-jobs (online/active-job/activation gates) → PUT respond {accept, version}
 → checks sent+unexpired+version== + activation + mutex + no-active-job + ACCEPT-eligibility + travel feasibility
 → atomic findOneAndUpdate{_id, status∈[pending,broadcasted], tech=null} → accepted+tech+assignedAt
 → winner accepted/accepted, losers expired/superseded → notifyCustomerJobAccepted + job_taken + jobs_changed
Execute: PUT status on_the_way→reached→in_progress→completed (canTransition + version CAS;
 autoCancelAt=null on OTW/completed; completed→released + completedAt + settleBookingEarningsIfEligible + PAYMENT_DUE)
Cancel customer: PUT /booking/cancel/:id [pending,broadcasted,accepted,on_the_way,reached] + fee table
 → atomic →cancelled/customer_cancelled/released + expire offers + socket tech
Cancel tech: PUT /booking/technician/cancel/:id [accepted…in_progress] TX: ₹200 penalty debit + jobRejectCount++
 → scheduled-future: RESET pending/unassigned/tech=null (re-dispatch) ELSE cancelled
Re-accept: PUT /booking/reaccept/:id (penalty % from GlobalSetting)
Crons: autoCancelAt→expired/cancelled; OTW-timeout (2× release then cancel); enforcement/escalation; reminders h24/h1/m15; orphan cleanup
```

Failure: no eligible techs → stays pending/broadcasted until autoCancelAt → expired. Retry: outbox/dispatch workers backoff maxAttempts 6. Timeout: autoCancelAt + OTW-timeout. Cancel: above. Dup: idempotencyKey booking-created:<id>; DispatchOutbox unique pair; claim atomic. Concurrent accept ×N: single findOneAndUpdate winner; losers 409. Partial: broadcast TX all-or-none; socket best-effort + worker. Admin: getOwnerAllBookings/ById, deleteBookingAsAdmin, dispatch stats/retry/worker controls.

## 4. Business Rules & Invariants

1. **Broadcast never precedes commit.** Enforcement: outbox TX (new pipeline only). Fail: legacy bypass. Solution: delete legacy body, single pipeline. DB: outbox row in same txn.
2. **One winner per booking (atomic claim on status+version+tech=null).** Enforcement: findOneAndUpdate (good). KEEP + extend version predicate to pre-version docs (migration sets version).
3. **Linear execution (no teleport accepted→completed).** Enforcement: NONE (skip-jumps allowed). Solution: enforce accepted→on_the_way→reached→in_progress→completed (+reached→completed only with workImages). App + tests.
4. **Completion requires accountability (travel + evidence policy).** Solution: require OTW/reached before in_progress; workImages for direct complete.
5. **Cancel fee/penalty recorded AND collected-or-receivable (not fiction).** Enforcement: recorded; collection via wallet hold/payment — verify collector exists (M9/refund-link). Solution: fee → payment intent or waiver/dispute with audit; penalty debit with shortfall → outstanding (already split debited/policy — keep + reconcile job).
6. **A terminal booking never reopens except scheduled-tech-cancel re-dispatch (explicit, audited).** Solution: re-dispatch writes CLEAN doc + assignmentAttempts entry (drop dirty penalty/cancel carryover).
7. **Payment/settlement vocab matches schema.** Fix drift (utils promise order_created/success/blocked/reversed; schema lacks them) — align to schema enums.

## 5. Current Problems

- **P0 — Two creation pipelines (outbox bypass).** Evidence: `serviceBookController.createBooking` vs `bookingService.createBookingAndOutbox`. Impact: lost broadcasts (no retry). Fix: route legacy through pipeline; delete body.
- **P0 — Skip-step execution (`accepted→completed` one call).** Evidence: BOOKING_TRANSITIONS entries + updateBookingStatus allows. Impact: fake completions → payout. Fix: linearize; 409 on skip.
- **P0 — bookingType chaos (`instant|schedule` vs `scheduled` input/checks).** Evidence: schema enum vs `bookAgainController` `scheduled||schedule`, legacy `scheduled→schedule` map. Impact: misqueries, version-predicate misses. Fix: single `instant|schedule` + migrate old docs.
- **P1 — Customer cancel excludes in_progress vs table allows; tech-cancel re-dispatch dirty flags.** Fix: explicit in_progress policy both layers; clean re-dispatch + attempts entry.
- **P1 — Broadcasted-zero-tech stuck; accepted…→expired bypasses canTransition; pre-version docs race.** Fix: re-queue transition, cron via canTransition, backfill version.
- **P1 — Job list/admin endpoints under-scoped (Auth-only).** Evidence: jobs/current|accepted, admin/jobs/history. Fix: role scoping.
- **P2 — Vocab drift payment/settlement; cancel of paid without refund hook (M10 link).** Fix: align enums; paid-cancel → Refund pipeline.
- **P2 — `radius` from client unchecked in legacy path.** Fix: server-computed radius only.

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P0 | Fake completion → settlement | Tech jumps accepted→completed | allowed | money out | linearize + evidence | transition test |
| P1 | Cross-tech job hijack | Tech B completes A's job | ownership check? verify | integrity | technicianId===req.tech on all status writes | IDOR matrix |
| P1 | Customer cancels tech's in-progress unfairly / or cannot cancel stuck job | policy gap | 409 vs table mismatch | dispute | explicit policy + fee | policy test |
| P2 | Client radius/price influence | forged radius | legacy unchecked | matching abuse | server-only | mass-assignment test |

## 7. Database Findings

ServiceBooking: fix bookingType enum usage (migrate `scheduled`→`schedule` — verify which value predominates first; "Not verified" until migration dry-run counts); align payment/settlement enums with code constants (drop phantom values or implement blocked/reversed handling — decide with M8/M9); ADD `version` default backfill; KEEP leases/attempts/reminders/broadcastVersion; ADD partial index for claim queries `{status, activeBroadcastVersion}`. Broadcast/Offer/Outbox schemas: KEEP + add `cancel_revoke` kind + `broadcasted→pending` support.

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| accept claim | {_id} + status/version/tech predicates — _id ✓ | verify docsExamined==1 via explain; backfill version so predicate matches |
| eligible techs | location 2dsphere + workStatus + skills + perms | covered compound review in staging; limit candidates (e.g. 50) before feasibility (CPU guard) |
| my-jobs feed | {technicianId,status} ✓ + broadcast joins | avoid N+1: single $in fetch bookings for broadcasts |
| cron sweeps | {status,autoCancelAt}, {status,bookingType,remindersSent.*}, {leaseUntil,status} ✓ | KEEP; verify each sweep explain; batch size caps |
| admin lists | {status,bookingType,createdAt} NEW | paginate |

## 9. Concurrency Findings

- Accept race: atomic claim (good, no Redis). Keep + test 20-way race → exactly one winner.
- Status progression race (two PUTs): version CAS (good) — extend to ALL writers incl. crons/admin; loser 409 with fresh GET.
- Broadcast version race (re-broadcast vs accept): accept pins `activeBroadcastVersion` (good); re-broadcast bumps — verify accept rejects stale version (protocol already passes version — enforce equality).
- Penalty debit race: idempotencyKey penalty:<bookingId> (good).
- Multi-instance workers: lease claim (good); verify lease TTL > max processing time.

## 10. Transaction Findings

- Create: ServiceBooking + BookingOutbox in ONE txn (keep). Broadcast fan-out AFTER commit via outbox (keep — never in txn).
- Match TX: JobBroadcast×N + booking bump + DispatchOutbox×N in ONE txn (keep; ordered:false swallow dupes documented).
- Accept: single atomic findOneAndUpdate + loser updates — single-doc atomic + subsequent writes; where multi-doc (offers + booking), use txn (verify current; add if missing).
- Tech-cancel: penalty + booking + offers in txn (keep).
- Status steps: single-doc CAS (no txn). Crons: per-booking lease + CAS (no global txn).

## 11. Outbox / Worker Findings

Pattern correct; gaps: legacy bypass (fix §5); only `booking_created` event (add or document); only `job_new` kind (ADD `cancel_revoke` for offline techs); ProductBooking has no outbox (M7). Retry/backoff/maxAttempts/TTL/lease all present — verify numbers: maxAttempts 6, backoff curve, lease TTL vs worker interval, 24h TTL cleanup (document in code comments + here: keep).

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| create | booking-created:<id> | replay → reuse booking (return existing) |
| broadcast fan-out | unique (booking,tech,kind) | replay → dupes swallowed |
| accept | claim atomic + idempotent winner response | winner replay → 200 same; losers 409 |
| status step | version CAS | replay same version → 409 (client refetch; acceptable) — or make step+version return current (nicer: 200 with state) — decide + document |
| cancel | terminal guard | replay → 200 same terminal |
| re-accept | penalty idempotency + claim | replay safe |

## 13. API Contract Findings

`PUT /status/:id`, `/job-broadcast/respond/:id`, cancels, reaccept — keep paths. Add `409 VERSION_MISMATCH/ALREADY_CLAIMED` codes (stable). Paginate all lists (my-jobs cursor `since` already; admin lists need page/limit). `allowedStatus` list in updateBookingStatus excludes `accepted` confusingly — replace with single `to` + canTransition(from,to).

## 14. Target Architecture

```text
Route (Auth + requireRole + validators) → Controller-thin → Application Service (booking.service)
 → Domain: bookingTransitions (SOLE writer gate) + matching.policy + fee.policy
 → Repository → Mongo (txn: create/accept/cancel; CAS: steps) → Outbox rows (same txn)
 → Workers (outbox/dispatch/cron) → notify() (M11) + settlement hook (M9)
```

## 15. Target Schema

KEEP aggregate; FIX bookingType values (migrate); ALIGN payment/settlement enums; BACKFILL version; ADD claim partial index; ADD `cancel_revoke` outbox kind; quarantine legacy statuses (-Smith: keep normalize hook one more release, then drop enum values after migration count==0).

## 16. Target Query Design

Claim: `findOneAndUpdate({_id, status:{$in:[pending,broadcasted]}, technicianId:null, activeBroadcastVersion:expected}, {accepted...})` → explain IXSCAN via _id. Candidate search: 2dsphere + filters + limit 50 + feasibility in memory (bounded). Sweeps: indexed range + batch 100 + lease.

## 17. Target File Structure

```text
modules/booking/
├── routes/booking-customer.routes.js | booking-technician.routes.js | booking-admin.routes.js | dispatch-admin.routes.js
├── controllers/booking-lifecycle.controller.js | broadcast.controller.js | book-again.controller.js (thin)
├── services/booking.service.js (pipeline — frozen) | matching.service.js | fee.service.js
├── domain/booking.transitions.js  # NEW sole gate (replaces scattered canTransition call sites? — same lib, enforced import)
├── repositories/booking.repo.js | broadcast.repo.js | outbox.repo.js
├── validators/booking.validator.js # NEW
├── workers/booking-outbox.worker.js | dispatch.worker.js | booking.cron.js (moved, same logic)
└── tests/...
```

## 18. State Machine

```text
pending → broadcasted → accepted → on_the_way → reached → in_progress → completed (terminal)
pending|broadcasted → cancelled | expired (terminal)
accepted|on_the_way|reached|in_progress → cancelled (policy: customer in_progress per fee-policy; tech per penalty path)
scheduled-tech-cancel: accepted… → pending (re-dispatch; audited; clean doc) — the ONLY backward edge
broadcasted + zero-tech → pending (re-queue; NEW)
```

Who: customer (cancel own, cancellable set), tech (accept/steps/cancel own assigned), system/cron (expire/timeout/re-queue per lease+CAS), admin (read + delete + dispatch ops; no status jumps except defined cancel). All via `booking.transitions.js`; direct `status=` writes forbidden (lint rule + grep test).

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| 20 techs accept at once | 1 winner, 19 get 409 + jobs_changed | atomic (good) | KEEP + load test |
| Accept stale version | 409 | version checked | KEEP |
| Step skip | 409 | allowed | 409 + test |
| Cancel in_progress (customer) | per policy + fee | 409 vs table | explicit + test |
| Paid cancel | → Refund (M10) | direct cancelled | link Refund |
| Zero techs | re-queue pending | stuck | re-queue |
| Offline tech cancel notice | revoke on reconnect | lost | cancel_revoke |
| Pre-version doc claim | succeeds | predicate miss | backfill |
| Cron vs tech step race | one wins CAS | ? | version CAS everywhere |

## 20. Test Plan

Unit (transitions matrix incl. skips, fee table, version CAS); integration (create TX, accept TX, cancel TX + penalty); API (all endpoints × roles × codes); transaction (kill mid-TXN → rollback, outbox absent); concurrency (20-way accept, step race, double cancel); idempotency (replay table); security (IDOR, fake-complete, radius/price tamper); failure (worker crash mid-fan-out → outbox retry; FCM down → socket still + retry); regression (happy path shape); load (broadcast fan-out 500 techs, accept storm — measure, don't fabricate).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (happy path + transitions + claim). P3 backfill version + bookingType normalize + indexes background. P4 unify pipeline (delete legacy body) + linearize + clean re-dispatch + re-queue + cancel_revoke (behind same routes). P5 shadow: run new transition checks log-only 48h. P6 migrate old `scheduled` docs. P7 enforce. P8 monitor (claim contention, broadcast latency, stuck-broadcasted count → 0). P9 remove legacy enum values + legacy code. Rollback: redeploy; transitions are app-level (DB additive until P9 enum prune).

## 22. Production Verification Checklist

Code (one pipeline, one transition gate, no direct writes); DB (enums/indexes/explain/pagination/backfill counts); Security (ownership, linearize, guards); Reliability (claim atomic, CAS everywhere, outbox+workers+retry verified, revoke path tested); Observability (requestId/bookingId logs, claim-win/loss metric, broadcast latency, stuck counts, fee/penalty audit); Tests green; Deployment (background indexes, compat, rollback).

## 23-26. Files

- Create: domain/booking.transitions.js (extract, not new logic), validators, repos, workers-moved, tests, backfill scripts.
- Modify: serviceBookController (delete legacy, split), bookAgain (enum fix), broadcastController (guards), bookingStatus (remove skips), matching (re-queue), dispatchQueue (revoke kind), bookingCron (via gate), routes (guards + pagination).
- Merge: legacy createBooking body INTO bookingService (then delete original).
- Delete: legacy body, legacy enum values (P9), dead `scheduled` branches.

## 27. Risks / Open Questions

in_progress customer-cancel policy (allow+fee vs forbid) — PRODUCT DECISION REQUIRED (table vs endpoint disagree). `blocked/reversed` settlement states — decide with M9 (implement or drop). Fee collection mechanism (wallet hold vs payment intent) — joint M9/M10. Cross-module: M1 gates, M2 dispatchable + location, M3 zone/permission + revalidation, M4 snapshot, M5 checkout caller, M8 payment state, M9 settle hook, M10 paid-cancel refunds, M11 notify + socket, M12 admin reads.

## 28. Final Acceptance Criteria

Single pipeline; linear execution enforced; claim exactly-once under storm; re-queue + revoke live; stuck-broadcasted == 0; no direct status writes; indexes verified; tests green; migration counts clean.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: pipeline unification + transition linearization + cancel-policy decision ship together; shadow 48h; backfills verified; storm tests green. Must NOT break: M5 checkout, M8 payment hooks, M9 settle hook, M11 notify/socket contracts, M2/M3 eligibility inputs.
