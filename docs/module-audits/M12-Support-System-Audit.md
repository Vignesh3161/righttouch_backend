# M12 — Support (Report/Complaint/Rating) & System (Settings/Audit/Dashboard): Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8
> Scope: ONLY M12 (trust loop intake + quality signal + admin knobs/audit). Money execution → M10; notify delivery → M11.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M12 closes the trust loop: customer `createComplaint` (ownership + window + no-open-duplicate → `open + slaDeadline+24h` → `freezeForComplaint` → notify + audit + admin-unread) → admin `under_review → resolved_refunded (→ M10 Refund) | resolved_no_refund` → `releaseOnResolution` → notify + audit; tech `respond` (evidence); customer `withdraw → withdrawn`; SLA cron escalates; legacy `reportController` shims old `/api/report*` onto `complaintService`. Quality signal: `Rating` one-per-booking (completion-gated) + averages rollup. System: `GlobalSetting` live-read knobs (reaccept penalty, categories, refund policy) + `AuditLog` immutable trail + product dashboard/sales/audit-log reads + health/swagger. Clean separation (intake here, money in M10) is correct; gaps: duplicate report/complaint surfaces, freeze-release skip logic needs multi-complaint tests, rating rollup races, settings without cache/version, and audit coverage unverified per mutation. Verdict: **YES** — safe rewrite (no money moves here; money delegated), provided trigger contracts to M10 are pinned and the legacy report shim stays until clients migrate.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/Report.js` | Complaint dossier: open\|under_review\|resolved_refunded\|resolved_no_refund\|withdrawn\|expired + category/faultParty/refund-penalty/SLA/freeze + isRead badge | complaintService, reportController | Booking, User, Tech | YES | REMAIN |
| `Schemas/Rating.js` | One-per-booking (bookingId unique) 1-5 + content label; rollup indexes | ratingService | Booking | YES | REMAIN |
| `Schemas/GlobalSetting.js` | Singleton key→value + updatedBy (penalty %, categories, refund policy) | refundPolicy, reportCategories, adminSettings | — | YES | REMAIN, add cache+version |
| `Schemas/AuditLog.js` | Immutable actor/action/target/before/after/reason/metadata | writeAuditLog callers everywhere | — | YES | REMAIN |
| `Controllers/complaintController.js` | New API: customer create/withdraw/categories/mine; admin list/get/update/reject; tech list/detail/respond/refunds | userReports, adminRefunds-complaints, technician complaint routes | complaintService | PARTIAL (thin over service — good) | REMAIN |
| `Controllers/reportController.js` | Legacy shim /api/report* → complaintService (maps resolved→resolved_no_refund) | Routes/User.js | complaintService | PARTIAL (compat) | REMAIN until clients migrate |
| `Controllers/ratingController.js` | Rating CRUD + mine + rebuildAggregate | Routes/User.js | ratingService | PARTIAL (thin — good) | REMAIN |
| `Controllers/adminSettingsController.js` | GET/SET reacceptPenaltyPercent (0-100) + audit; getSettingValue helpers | admin routes? (verify mount) | GlobalSetting, audit | YES | REMAIN |
| `Controllers/productDashboardController.js` | Turnover summary, sales report, AuditLog query | adminProductDashboardRoutes | ProductBooking, Payment, Quotation, Product, AuditLog | YES (read-only) | REMAIN, add caching |
| `Services/complaintService.js` | Lifecycle: create/list/detail/update/reject/withdraw/respond + freeze/release + auto-refund trigger + notify+audit+broadcastAdminUnread | controllers | Report, freeze, refund trigger (M10), notify (M11), audit | YES (keep!) | REMAIN untouched (logic) |
| `Services/ratingService.js` | Guarded create (owns booking + completed + no dup, targets from booking) + updateRatingAverages/rollup/rebuild | ratingController | Rating, Booking, Profile/Service/Product | YES | REMAIN, fix rollup race |
| `Utils/complaintFreeze.js` | freezeForComplaint/releaseOnResolution/releaseExpiredHolds (ReserveHold→frozen + BookingPayoutBlock) | complaintService, M10 engine, cron | ReserveHold, Block | YES | REMAIN |
| `Utils/reportCategories.js` | Static 7 + GlobalSetting override | category endpoints | GlobalSetting | YES | REMAIN |
| `Utils/audit.js` | Never-throws writeAuditLog (optional session) | all mutating paths | AuditLog | YES | REMAIN |
| Routes | userReports (/api/user/reports), User.js report/rating subsets, technician complaints subset, adminRefunds complaints subset, adminProductDashboardRoutes | index.js | controllers | YES | REMAIN, document ownership |

## 3. Actual Current Flow

```text
Complaint: customerCreateReport → validate ownership + withinComplaintWindow + no open duplicate
 → Report.create(open, slaDeadline+24h) → freezeForComplaint → notify(COMPLAINT_RECEIVED + FILED_AGAINST_YOU)
 + writeAuditLog + broadcastAdminUnreadCounts → admin under_review → resolved_refunded (→ M10 createRefund trigger)
 | resolved_no_refund → releaseOnResolution (SKIP if other active complaint on same booking/tech) + notify + audit
Tech: respond (evidence + images) → notify admin; Customer: withdraw → withdrawn + release
SLA: complaintSlaEscalation (1h) escalates overdue; freeze expiry (15m) releases stale holds
Rating: createService/ProductRating → loadBooking → completed? + owns? + no dup? → Rating.create
 → updateRatingAverages (Profile.rating / Service.ratingSummary / Product.ratingSummary)
Settings: SET key → GlobalSetting.upsert + audit → read live per-request (no cache)
Dashboard: turnover/sales/audit-log reads (aggregations, admin-only)
```

Failure: duplicate open → 409; outside window → 422; withdraw resolved → 409. Retry: safe (guards). Timeout: SLA escalation, not auto-resolve. Cancel: withdraw. Dup: dedupe guard. Concurrent: double-create race (§9). Partial: freeze succeeds but notify fails → notify best-effort (correct: dossier exists, badge cron/admin poll covers). Admin: reject with reason + audit.

## 4. Business Rules & Invariants

1. **Complaint intake never moves money; resolution moves money ONLY via M10 Refund.** Enforcement: trigger call (verify) — no direct payment writes here. KEEP + forbid direct writes (grep test).
2. **One open complaint per (booking, customer) scope (dedupe).** Enforcement: no-open-duplicate check (good). KEEP + unique partial guard (§9).
3. **Freeze holds while ANY active complaint exists; release only when none remain.** Enforcement: skip-if-other-active (good). KEEP + multi-complaint tests.
4. **SLA clock starts at file time (+24h), escalation audited.** KEEP.
5. **One rating per booking; only completed bookings; only owner rates.** Enforcement: guards (good). KEEP.
6. **Settings changes are audited with before/after + actor.** Enforcement: audit on SET (good). KEEP + extend to ALL keys (verify coverage).
7. **AuditLog is append-only (never updated/deleted by app).** Enforcement: convention — add comment + test (no update/delete call sites).

## 5. Current Problems

- **P1 — Double surfaces (report* legacy + complaint* new) with status mapping (`resolved→resolved_no_refund`).** Impact: client confusion, mapping bugs. Fix: keep shim, document mapping, migrate clients, then remove (P10).
- **P1 — Rating rollup read-modify-write races (concurrent ratings/rebuild vs create).** Evidence: updateRatingAverages pattern. Fix: atomic `$inc`-based avg (sum+count) or conditional rebuild lock; add unique booking guard (exists) + test storm.
- **P2 — No-open-duplicate check racy (two simultaneous creates).** Fix: partial-unique index (bookingId, customerId) where status ∈ open/under_review + catch → 409.
- **P2 — Settings live-read per request (no cache) + no versioning/rollback.** Fix: 30s in-memory cache with version + history (keep audit).
- **P2 — Dashboard aggregations uncached + possibly unbounded.** Fix: paginate + cache 60s + cap ranges.
- **P3 — `isRead` badges on Report/Profile vs M11 Notification truth (two badge systems).** Fix: document (domain badges stay; they feed adminNotificationController counts) — keep, don't unify prematurely.

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P1 | Complaint IDOR (view/respond another's) | user B GET /:id of A's complaint | ownership checks? verify | dossier leak | owner-or-admin-or-assigned-tech | IDOR matrix |
| P1 | Rating fake (rate uncompleted/other's booking) | forged bookingId | guards exist (good) | false scores | KEEP + tests | guard tests |
| P2 | Evidence upload abuse | malicious images via respond | upload.array(images,5) + Auth+tech | storage/malware | mime+size allowlist | fuzz |
| P2 | Admin reject without reason | silent reject | reason required? verify | dispute opacity | require reason + audit | test |

## 7. Database Findings

Report: ADD partial-unique (bookingId,customerId) where open/under_review + `{status,slaDeadline}` sweep index + `{technicianId,status}` for tech lists. Rating: KEEP bookingId unique + ADD `{targetType,targetId,createdAt}` for rollup verification queries. GlobalSetting: ADD `{key}` unique (verify) + `version` + `history[]` (or rely on AuditLog — prefer AuditLog, add version counter). AuditLog: ADD `{targetType,targetId,createdAt desc}` + `{action,createdAt desc}` + `{actorId,createdAt desc}`; TTL? NO — retain (legal hold; archive to cold storage instead — product call).

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| open-duplicate check | NEW partial unique (above) | single covered read |
| my complaints | NEW {customerId,status,createdAt desc} | paginate |
| tech complaints | NEW {technicianId,status,createdAt desc} | paginate |
| admin queue | NEW {status,slaDeadline} + assignedAdmin filter | paginate + sort SLA-first |
| rating rollup | bookingId unique ✓ + target aggregates | atomic inc (fix race) |
| audit-log reads | NEW triples above | paginate + cap range (max 90d default) |
| dashboard turnover | aggregations over bookings/payments | cache 60s + explain; precompute daily rollup if slow (measure first) |

## 9. Concurrency Findings

- Double complaint create: partial-unique backstop → one 409 (add index; no Redis).
- Double rating same booking: bookingId unique → one 409 (good). Rollup race: concurrent avg recompute → use atomic sum/count incs (fix) or serialize via booking-scoped update (acceptable: ratings are low-frequency; still fix with atomic).
- Rebuild vs create race: rebuild takes snapshot under booking lock? Simplest: rebuild is admin-only + idempotent (recompute from all ratings) — concurrent create during rebuild may be missed → rerun or accept eventual (document + test rerun converges).
- Settings concurrent SET: last-wins + audit trail (acceptable; add version check → 409 on stale version for admin UI safety).

## 10. Transaction Findings

- Complaint create (Report + freeze + audit-best-effort): Report + freeze in ONE txn (verify; audit outside txn best-effort — correct, audit must not block, but MUST still be attempted post-commit with retry-once).
- Resolve (status + release + refund TRIGGER): status + release in txn; Refund creation via M10 create (its own txn; saga-chained, idempotent — correct separation, no distributed txn).
- Rating create + rollup: same txn if rollup is $inc atomic (single booking+rating docs — keep in txn; verify).
- Settings SET + audit: audit best-effort post-commit (acceptable) — or same txn if session passed (prefer same txn; audit write is cheap).

## 11. Outbox / Worker Findings

No M12-owned outbox: money effects go through M10's RefundOutbox; notifications through M11's notify(); SLA/freeze-expiry via existing crons (1h/15m — correct). Verify cron coverage: expired-without-action complaints → `expired` status path exists in schema — confirm worker sets it (else ADD to SLA job).

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| create complaint | partial unique (booking,customer,open) | replay → 409 + existing id (return existing 200? Decide: 409 with existingId — document) |
| withdraw | terminal guard | replay 200 |
| respond (tech evidence) | append evidence (not idempotent by nature) | dup images possible → client-side disable + server dedupe by hash (optional; skip unless abused) |
| rating create | bookingId unique | replay → 409 |
| rating update | last-wins | replay safe |
| settings SET same value | no-op detection | return 200 unchanged (add) |

## 13. API Contract Findings

Keep all paths (legacy + new) during migration. Document ownership: `/api/report*` = legacy shim (deprecated header), `/api/user/reports` + admin/technician complaint paths = canonical. Codes: 409 duplicate/rated; 422 outside-window/invalid-transition; 404 unknown; paginate all lists (verify mine/admin paginated — add if not).

## 14. Target Architecture

```text
Route (Auth + requireRole) → Validator → Controller-thin → Service (complaint.service — frozen logic; rating.service; settings.service)
 → Repository → Mongo (txn: create/resolve/rating) → post-commit: freeze/release + M10 trigger (saga) + notify (M11, best-effort) + audit (best-effort w/ retry-once) + admin-unread broadcast
```

## 15. Target Schema

KEEP all collections; ADD indexes/uniques above; GlobalSetting ADD version (+cache); AuditLog indexes; NO field deletions.

## 16. Target Query Design

Guard reads single-indexed; lists lean+paginated SLA-first; rollups atomic; dashboard cached aggregations; all explain-verified.

## 17. Target File Structure

```text
modules/support-system/
├── routes/complaint-customer.routes.js | complaint-tech.routes.js | complaint-admin.routes.js
│   | rating.routes.js (same paths) | report-legacy.routes.js (shim, deprecated) | admin-settings.routes.js | dashboard.routes.js
├── controllers/* (thin; shim kept)
├── services/complaint.service.js (frozen) | rating.service.js (atomic rollup) | settings.service.js (+cache) | dashboard.service.js (+cache)
├── repositories/*.repo.js
├── validators/support.validator.js # NEW
└── tests/...
```

## 18. State Machine

```text
Report: open → under_review → resolved_refunded | resolved_no_refund (terminal) | rejected (terminal)
  open → withdrawn | expired (terminal); under_review → withdrawn (customer) | expired
Rating: none → created → updated (no delete? decide: allow delete only by admin with audit — currently deleteRatingController exists; keep + audit)
Settings: vN → vN+1 (audited; stale-version 409)
AuditLog: append-only (no transitions)
```

Transitions via complaintService only; no direct status writes.

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Double file same booking | one open + one 409 | check racy | unique + test |
| Two complaints, one resolves | freeze stays (other active) | skip logic | multi-complaint test |
| Last complaint resolves | release | release | KEEP + test |
| Resolve with refund, M10 down | status set + trigger queued? | ? | trigger retry/outbox-note (design: M10 create idempotent; retry with backoff; status stays resolved with refundPending flag? ADD flag + reconciler) |
| Rate other's booking | 403 | guards | KEEP + test |
| Rebuild during create | converges on rerun | ? | document + test |
| Settings concurrent edit | version 409 | last-wins | version guard |

## 20. Test Plan

Unit (window check, dedupe predicate, rollup math, version guard); integration (create+freeze TXN, resolve+release, rating+rollup); API (all surfaces × roles, legacy mapping, pagination); concurrency (double-file, double-rate, rebuild-vs-create); idempotency (replay table); security (IDOR, upload fuzz, reason-required); failure (M10 down → pending flag + reconciler; notify down → flow unaffected; Mongo down → 503); regression (legacy report shape); load (admin queue p95, dashboard agg at 1M bookings — measure + cache).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (legacy mapping goldens, freeze skip logic, rollup). P3 additive indexes background. P4 atomic rollup + unique dedupe + version-guarded settings + cached dashboard (same routes). P5 legacy deprecation headers. P6 refundPending flag + reconciler (with M10). P7 monitor (SLA breach rate, freeze aging, rating distribution). P8 client migration off legacy shim. P9 remove shim. Rollback: redeploy; additive until P9.

## 22. Production Verification Checklist

Code (single lifecycle service, no money writes, no direct status writes); DB (uniques/indexes/explain/pagination/append-only audit); Security (IDOR, guards, upload policy, reason-required); Reliability (dedupe, TXN, trigger retry + reconciler, freeze skip covered); Observability (SLA metric, freeze age, refundPending queue, audit completeness check); Tests green; Deployment (background indexes, deprecation headers, rollback).

## 23-26. Files

- Create: validators, repos, tests, refundPending reconciler (with M10).
- Modify: schemas (indexes/uniques), ratingService (atomic rollup), settings (cache+version), dashboard (cache+paginate), routes (deprecation headers).
- Merge: none (shim stays separate until P9).
- Delete: legacy report shim (P9, post-client-migration); nothing else.

## 27. Risks / Open Questions

`expired` worker path — confirm implemented (else add). `refundPending` design needs M10 joint sign-off. Audit retention/archive policy — product/legal call (this doc: engineering recommendation only, validate against applicable laws/contracts/policies). Evidence image retention — same. Cross-module: M6/M7 (booking refs + window), M9 (freeze/holds — joint), M10 (refund trigger + reconciler — joint), M11 (notify + badges), M1 (gates), M2 (tech respond + rating rollup target).

## 28. Final Acceptance Criteria

Dedupe + freeze-skip + rollup race-proof; triggers wired with retry; legacy mapping pinned; settings versioned + audited; dashboard cached; indexes verified; tests green.

### Can this module safely be rewritten now?

```text
YES
```

Safest alongside M4 (no money moves here). Conditions: M10 trigger contract joint-pinned with retry; dedupe unique built first; legacy shim retained. Must NOT break: M9 freeze/hold reads, M10 trigger inputs, M11 notify/badge calls, M1 gates, legacy mobile report paths.
