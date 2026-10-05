# M7 — Product & Quotation: Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8 · Outbox: QuotationDelivery
> Scope: ONLY M7. Cross-module notes under §27.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M7 sells products via quotes: `ProductQuoteRequest` (single active thread per customer+product) → admin `Quotation[draft revN]` → `send` (TX supersede + `enqueueDeliveries`) → customer `view/accept(partial items allowed → N ProductBookings[paymentGroupId])/reject` → pay (M8) → admin `complete` (rating gate). The flow is well-structured (TX send/accept, idempotent accept-by-count, unique delivery rows), but `revise` doesn't set old `status=superseded`, the request lock includes `expired/rejected` (mutating old rows instead of new threads), deletes allow removing live `sent/viewed` offers, `converted` is never executed, `ProductBooking` has no machine/outbox, and paid-cancel has no refund hook. Verdict: **YES WITH CONDITIONS** — fix revise/supersede atomicity, lock scope, delete guards, converted close-loop, and paid-cancel→Refund link in one release.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/ProductQuoteRequest.js` | Quote thread + snapshots + status + assignedAdmin + version + history; partial-unique lock | quoteRequestService, controllers | Product, User | YES | REMAIN, fix lock scope |
| `Schemas/Quotation.js` | Versioned offer + items[].status + immutable paise snapshot + status/paymentStatus/notificationStatus + rev/supersedes; single-active guard | quotationService, acceptanceService | Request, Product | YES | REMAIN, fix revise + converted |
| `Schemas/ProductBooking.js` | Product order + amount*Paise + location/address + paymentStatus(+nonsense `completed`) + status + quotation/paymentGroup/quoteRequest links | productBooking controller, paymentSettlement | Quotation, Request | PARTIAL (no machine) | REMAIN, add machine |
| `Schemas/QuotationDelivery.js` | (quotation,channel,type) unique outbox | quotationDeliveryService | — | YES | REMAIN (or merge M11 later) |
| `Controllers/productQuoteRequestController.js` → `Services/productQuoteRequestService.js` | customer create/list/get/update/cancel + admin list/get/assign/status/delete | productQuoteRoutes + adminQuotationRoutes | Request | YES | REMAIN |
| `Controllers/quotationController.js` → `Services/quotationService.js` + `quotationAcceptanceService.js` + `quotationPricingService.js` | customer list/get/view/accept/reject + admin createDraft/list/get/updateDraft/send/resend/revise/delete/paymentStatus | same routes | Quotation, Request, ProductBooking, Delivery | YES | REMAIN, fix revise/delete/converted |
| `Controllers/productBooking.js` | list/detail (commission stripped), customer update (qty-only unpaid), cancel, admin complete | User.js + quote routes + adminQuotationRoutes | ProductBooking, Payment | PARTIAL | REMAIN, add cancel-refund link |
| `Services/quotationDeliveryService.js` | enqueueDeliveries (TX), processQuotationDeliveries (30s), recordProviderCallback, expireQuotations (1h) | send/resend/accept + cron | Notification, Twilio | YES | REMAIN |
| `Utils/quotationStateMachine.js`, `quotationNumber.js` | Transitions guards + human numbers | services | — | YES | REMAIN, align table (expired→revise allowed path) |

Routes: customer `productQuoteRoutes` (21 endpoints) + legacy `User.js` product-booking subset + admin `adminQuotationRoutes` (16 endpoints) — full lists in responsibilities doc.

## 3. Actual Current Flow

```text
Customer POST product-quote-requests {productId,qty,location} → lock check (open thread incl expired/rejected
 → if expired/rejected: mutate old row →under_review and RETURN IT) else create quote_requested
Customer PATCH :id (qty/notes/location) → if sent/viewed quotes exist: supersede + request→under_review
Customer POST :id/cancel [quote_requested,under_review only] → cancelled
Admin POST :id/assign → under_review (+assignedAdminId); PATCH :id/status (table-guarded jumps)
Admin POST /quotations {quoteRequestId, money, items?} → draft revN + request→quotation_prepared
Admin PATCH /quotations/:id (draft only else 409; server recalc totals)
Admin POST :id/send [draft only] TX: supersede other sent/viewed → sent + request→quotation_sent
 + enqueueDeliveries(unique rows); POST :id/resend (sent/viewed) → enqueue again
Admin POST :id/revise (not accepted/converted) → new draft rev+1 (supersededAt/By set; BUG: old status NOT superseded)
Customer POST :id/view [sent→viewed idempotent]
Customer POST :id/accept → TX: claim sent/viewed/accepted + validUntil → accepted
 + create 1..N ProductBooking[active/pending, paymentGroupId] (idempotent by existing count)
 + request→accepted + enqueue ACCEPTED deliveries; partial: acceptedItemIds subset → items accepted/rejected
Customer POST :id/reject|decline [sent/viewed→rejected] + request →under_review (re-open)
expireQuotations: sent/viewed past validUntil → expired + request →expired
Pay via paymentController (bookingId or quotationId) → paid; Admin PUT product-bookings/:id/complete [active→completed, rating gate]
```

Failure: assign/accept races → 409; expired quote → 410 + revise path; paid booking update blocked; cancel paid → currently plain cancelled (NO refund — §5). Retry: send/resend idempotent (unique delivery rows); accept idempotent by count (racy — §9). Timeout: validUntil + expiry worker. Cancel: request-cancel (pre-quote) vs booking-cancel (post-accept). Dup: lock returns existing thread (intended). Concurrent: two accepts → double-create window (§9). Partial: multi-item partial accept (good). Admin: delete guards incomplete (§5).

## 4. Business Rules & Invariants

1. **One active thread per (customer,product); one active quotation per request.** Enforcement: partial-unique indexes (good) — but lock wrongly includes expired/rejected. Fix scope to truly-open states.
2. **Totals server-computed, snapshot immutable.** Enforcement: recalc on draft update (good). KEEP.
3. **Superseded revisions are unclaimable.** Enforcement: BROKEN (revise leaves old status). Fix atomic `status=superseded`.
4. **Accept is exactly-once per quotation×item.** Enforcement: app-level count (racy). Fix DB unique guard.
5. ** accepted→converted closes on payment.** Enforcement: MISSING (converted dead). Fix M8 hook TX.
6. **Paid orders cancel via Refund, never by silent status flip.** Enforcement: MISSING. Fix link M10.
7. **Deletes never orphan live offers/threads.** Enforcement: incomplete guards. Fix block sent/viewed + parents with drafts.

## 5. Current Problems

- **P0 — revise doesn't supersede (old rev still claimable until send).** Evidence: `quotationService.revise` sets supersededAt/By only. Impact: double-offer acceptance. Fix: atomic status=superseded + version++ in same TX as new draft.
- **P0 — Accept idempotency racy (app count, no DB guard).** Impact: duplicate ProductBookings under concurrent accept. Fix: unique partial (quotationId,productId[,itemId]) + paymentGroupId grouping.
- **P1 — Lock includes expired/rejected → old thread mutated & returned (caller expects new requestNumber).** Fix: exclude terminal states from partial-unique; create NEW request on expired/rejected.
- **P1 — Delete guards allow killing sent/viewed + parents with drafts (orphans).** Fix: block + tests.
- **P1 — converted never executed; paymentStatus has nonsense `completed`; draft expiry missing.** Fix: M8-paid hook → converted + paymentStatus=paid; expire stale drafts cron.
- **P1 — Paid product-cancel has no refund hook (money dangles); cancel checks dead states (ready_for_delivery…).** Fix: cancel(paid)→Refund pipeline; drop dead checks; forbid qty edit after paid (exists) + after 24h window?.
- **P2 — quotation.paymentStatus updated via unguarded admin endpoint (no transition).** Fix: system-only writes (paid via hook, partial via defined rule) + audit.
- **P2 — Multi-product items[] vs single productId lock mismatch.** Fix: lock on (customer,productId) per line OR thread-per-line model documented + unique per (request,product).

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P1 | Accept another customer's quote | user B accepts user A quotationId | ownership check? verify | theft of pricing/orders | customerId===req.user on view/accept/reject | IDOR matrix |
| P1 | Admin price manipulation post-send | PATCH sent quote | draft-only 409 (good) | — | KEEP + test | 409 test |
| P2 | validUntil bypass (accept expired) | replay accept | validUntil checked (good) | — | KEEP + test clock skew | boundary test |
| P2 | Payment amount tamper | client sends amount | server snapshot (verify) | underpay | assert ignored | mass-assignment test |

## 7. Database Findings

Request: FIX partial-unique filter to open-states only (exclude expired/rejected/cancelled → new thread allowed). Quotation: KEEP single-active guard; revise sets status atomically. ProductBooking: DROP `completed` from paymentStatus enum (migrate); ADD unique partial (quotationId,productId) [or +itemId for partial]; ADD `{customerId,status,createdAt}` + `{paymentGroupId}` indexes. Delivery: KEEP unique triple.

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| open thread lookup | partial unique (customer,product) ✓ (fix filter) | KEEP + verify filter |
| active quotation per request | partial unique (request, sent/viewed) ✓ | KEEP |
| accept existing-count | NEW unique guard (replaces count read) | atomic insert, catch dup → return existing |
| my requests/bookings lists | NEW {customerId,status,updatedAt desc} | paginate |
| admin queues | NEW {status,updatedAt} + assignedAdmin | paginate + filter |

## 9. Concurrency Findings

- Concurrent accept: count-check races → DB unique backstop (no Redis). Loser catches 11000 → returns existing group (200).
- Concurrent send ×2 drafts: supersede TX serializes (second supersedes first — acceptable, last-wins, audited). Add version check to fail loudly instead? Prefer 409 with message (safer for admins).
- Concurrent request-create same product: partial-unique → one wins, other returns existing thread (catch → fetch + return 200). Add.
- Delivery enqueue concurrent: unique triple swallow (good).

## 10. Transaction Findings

- send (supersede + status + request + enqueue): ONE txn (keep). resend: enqueue only (no txn needed). revise (old→superseded + new draft): ONE txn (fix to include status). accept (claim + N bookings + request + enqueue): ONE txn (keep + add unique guard). request update superseding quotes: txn (verify). complete: single update + rating check (no txn).

## 11. Outbox / Worker Findings

QuotationDelivery pattern correct (TX enqueue + 30s worker + unique rows + expiry sweeper). Failure never flips parent (good). ProductBooking fulfillment has NO outbox — acceptable today (no async fulfilment); if shipping/logistics added later, add `ProductBookingOutbox` (note, don't build now).

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| create request | partial unique | replay → return existing thread 200 |
| send/resend | unique delivery rows | replay safe |
| view | idempotent flag | replay 200 |
| accept | NEW unique (quotation,item) | replay → return existing bookings 200 |
| reject | terminal guard | replay 200 |
| cancel request | terminal guard | replay 200 |

## 13. API Contract Findings

Duplicate alias paths (`/product-quote-requests` vs `/product-quotes/request`, `PATCH` vs legacy) — keep one release + deprecate. `accept` with `acceptedItemIds` optional (absent = all) — document. Codes: 409 active-thread/draft-only-violation/race-lost; 410 expired; 422 invalid partial set; paginate lists.

## 14. Target Architecture

```text
Route (Auth + requireCustomer / authorizeRoles) → Validator → Controller-thin
 → Service (quote-request.service, quotation.service, acceptance.service, delivery.service)
 → Repository → Mongo (txn: send/revise/accept) → Delivery outbox (same txn) → Worker → notify (M11)
 → M8 payment hook → converted; M10 refund hook on paid-cancel
```

## 15. Target Schema

Request: lock filter FIXED (open = quote_requested,under_review,quotation_prepared,quotation_sent,viewed). Quotation: revise ATOMIC supersede; converted WIRED. ProductBooking: payment enum FIXED; unique accept guard ADDED; machine ADDED (active→completed|cancelled + payment pending→paid→refunded orthogonal). Delivery: KEEP.

## 16. Target Query Design

Lock lookup single partial-unique read; accept via inserts with dup-catch (no pre-count); lists lean+paginated; explain-verified.

## 17. Target File Structure

```text
modules/quote-product/
├── routes/quote-customer.routes.js | quote-admin.routes.js (same paths, deprecated aliases marked)
├── controllers/* (thin)
├── services/quote-request.service.js | quotation.service.js | acceptance.service.js | delivery.service.js (same, fixed)
├── repositories/*.repo.js
├── validators/quote.validator.js  # NEW
└── tests/...
```

## 18. State Machine

```text
Request: quote_requested → under_review → quotation_prepared → quotation_sent ⇄ viewed → accepted (terminal)
  └→ rejected → under_review (re-open) ; → cancelled | expired (terminal; NEW thread allowed after)
Quotation: draft → sent → viewed → accepted → converted (terminal; NEW via M8 hook)
  draft → superseded; sent|viewed → superseded | rejected | expired
ProductBooking: active → completed | cancelled (terminal); payment: pending → paid → refunded
```

All via state-machine guards; no direct status writes.

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Double accept click | one group, second returns same | racy dup | unique guard → same 200 |
| Accept expired | 410 + offer revise | checked? | 410 + test |
| Partial subset invalid item | 422 | ? | validate ids ∈ quotation |
| Revise accepted | 409 | blocked (good) | KEEP |
| Delete sent offer | 409 | allowed | block |
| Paid cancel | Refund created | silent cancel | link M10 |
| Expired request re-order | NEW thread | mutates old | new thread |

## 20. Test Plan

Unit (machines, totals, lock scope); integration (send/revise/accept TXNs); API (aliases, IDOR, codes); concurrency (double create/accept/send); idempotency (replay table); security (ownership, amount tamper); failure (delivery worker crash → retry; payment hook down → converted pending + backfill job); regression (shapes); load (accept storm 50-way).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (accept shape, lock behavior documented). P3 additive unique guard (background) + enum cleanup prep. P4 fix revise/lock/deletes/converted-hook/refund-link (single release). P5 alias deprecation. P6 migrate paymentStatus `completed` values + old mutated threads (data review). P7 shadow accept-guard (log-only). P8 enforce. P9 monitor. P10 remove aliases. Rollback: redeploy; additive until P6 data fix (backup).

## 22. Production Verification Checklist

Code (single guards, no direct writes); DB (uniques/explain/pagination/migrated enums); Security (ownership, amount-ignored); Reliability (TXNs, unique accept, delivery retry, converted backfill); Observability (accept latency, delivery failures, stuck drafts); Tests green; Deployment (background index, compat, rollback).

## 23-26. Files

- Create: validators, repos, tests, converted-backfill script.
- Modify: schemas (lock filter, enums, unique), quotationService (revise atomic), acceptanceService (unique guard), productBooking controller (refund link + drop dead checks), routes (deprecate aliases).
- Merge: none. Delete: aliases P10; dead status branches.

## 27. Risks / Open Questions

Partial-accept refund granularity (per-item cancel?) — defer, whole-order cancel only for now. `paymentStatus=partial` semantics undefined — define or drop. Cross-module: M4 (product truth + delete-block), M8 (pay + converted hook — joint), M10 (paid-cancel refund — joint), M11 (deliveries + notify), M12 (rating gate on complete).

## 28. Final Acceptance Criteria

Revise atomic; accept storm → single group; expired/rejected → new threads; live-offer deletes blocked; converted fires on paid; paid-cancel creates Refund; indexes verified; tests green.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: converted-hook + refund-link delivered jointly with M8/M10; unique accept guard built background-first with shadow; full IDOR + storm suite green. Must NOT break: M4 delete-block reads, M8 payment inputs, M11 delivery/notify, M12 complete→rating.
