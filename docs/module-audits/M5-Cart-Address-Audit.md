# M5 — Cart & Address: Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8
> Scope: ONLY M5 (staging before money moves). Cross-module notes under §27.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M5 stages intent: `Cart{customer,itemType,itemId,quantity,scheduledAt/TZ,faultProblem}` (unique triple) + `Address` book (default-driven listing) → `checkout` fans out to `ServiceBooking` + broadcast (services) and `ProductQuoteRequest` (products) in a transaction, then clears the cart. The flow works, but slot/zone validation happens late (at checkout, not add), `addressSnapshot.label` is unnormalized, checkout duplicates booking-build logic owned by M6, and cart schedule fields can drift from booking slot truth. Verdict: **YES** — low-risk rewrite: cart becomes a dumb staging list, checkout delegates to the single M6 pipeline, validation moves fail-fast to add-to-cart with re-validation at checkout.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/Cart.js` | customer+type+item staging + schedule + faultProblem, unique triple | cartController | — | YES (staging) | REMAIN, add validate-at-write |
| `Schemas/Address.js` | label/home-work-other, line/city/state/pincode, lat/lng paired, isDefault partial-unique | addressController/addressService, listing, checkout | — | YES (address truth) | REMAIN, normalize snapshot |
| `Controllers/cartController.js` | add(upsert+inc)/get(populate)/update/remove, setSchedule(TZ-validated), checkout (resolve location → strict district+zone gate → validate → buildServiceBookingDoc + create ProductQuoteRequest → clear cart → matchAndBroadcast) | Routes/User.js | Cart, Address, bookingService, quoteRequestService, geo resolver | PARTIAL (duplicates M6 build) | REMAIN, delegate build to M6 |
| `Controllers/addressController.js` → `Services/addressService.js` | search/reverse/create/list/get/update/delete/setDefault/getDefault + admin reads | Routes/address.js | Address, geo | YES | REMAIN |
| `Utils/resolveUserLocation.js` | saved\|gps → normalized snapshot | checkout, booking create | Address | YES | REMAIN, single normalizer |
| `Utils/slots.js` | Slot validation (Tomorrow/DayAfter, biz TZ) | setSchedule, booking input | locationConfig | YES | REMAIN, use at add-time too |

Routes: `Routes/User.js` cart/checkout (11 endpoints, all Auth) + `Routes/address.js` (10 endpoints, admin reads Owner/Admin). No M5 workers/crons.

## 3. Actual Current Flow

```text
Address: POST /api/addresses (label+lat/lng paired validated) → default drives getAllServices filter
Cart add: POST /cart/add {itemType,itemId,qty} → upsert triple (inc qty) [NO slot/zone check]
Schedule: POST /cart/set-schedule {scheduledAt+TZ} → slots.js validate → saved on item
Checkout: POST /checkout → resolveUserLocation → STRICT district+zone gate → validate cart lines
 → per service line: buildServiceBookingDoc(paise snapshot) → createBookingAndOutbox → matchAndBroadcast
 → per product line: create ProductQuoteRequest → clear cart → Response{bookings, quoteRequests}
```

Failure: invalid slot → 400/422 at setSchedule/checkout; unmapped zone → BLOCK at checkout (late — user already staged); empty cart → 400. Retry: safe (upsert semantics). Timeout: none. Cancel: remove item. Dup: add same triple → qty++ (intended). Concurrent: two adds → both upsert → qty+2 vs +1? (read-modify-write race — §9). Partial: services created but quote-request fails mid-checkout → mixed outcome (txn scope? verify — checkout SHOULD be single txn; if not, fix §10).

## 4. Business Rules & Invariants

1. **Cart never moves money; checkout is the money boundary.** KEEP; enforce by delegating to M6/M7 pipelines (no inline booking writes).
2. **Schedule/zone validity must hold at checkout (re-validated even if checked at add).** Current: only at checkout. Solution: check at add (fail fast) + re-check at checkout (TOCTOU).
3. **One default address per customer.** Enforcement: partial-unique (verify). KEEP.
4. **lat/lng paired; label normalized.** Enforcement: partial. Solution: normalizer single function + validator.
5. **Checkout is atomic per customer (all lines or none visible).** Fix: single txn; on failure return 409/503 with per-line reasons (no partial cart clear).

## 5. Current Problems

- **P1 — Late validation (slot/zone at checkout only).** Impact: UX dead-ends + wasted staging. Fix: validate at add/setSchedule + re-validate at checkout.
- **P1 — Checkout duplicates booking-build logic (drift from M6 pipeline).** Evidence: cartController checkout builds docs inline. Fix: call `bookingService.createBookingAndOutbox()` (single pipeline).
- **P2 — Add-to-cart read-modify-write qty race.** Fix: atomic `$inc` upsert (no read).
- **P2 — addressSnapshot.label unnormalized; snapshot shape differs between cart/checkout/booking.** Fix: single `buildAddressSnapshot()` in resolveUserLocation.
- **P3 — Unrestricted read/delete aliases (`/carts/:id`, `/cart/removed/:id`) with ownership inside controller.** Works but smelly; keep + test ownership, deprecate aliases later.

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P1 | IDOR cart item access | User A reads/deletes user B cart `:id` | ownership check inside controller (verify!) | data leak if missed | enforce `customerId===req.user` + test matrix | IDOR test per endpoint |
| P2 | Schedule spoofing (past/arbitrary TZ) | forged scheduledAt | slots.js validated | slot abuse | keep + test boundaries | boundary tests |
| P2 | Qty/price tampering | client sends price | server ignores (snapshot) — verify | free service if missed | assert no price input honored | mass-assignment test |

## 7. Database Findings

Cart: KEEP unique triple; ADD `{customerId,updatedAt}` index for list; ADD qty max cap (e.g. 10) + validators (scheduledAt future-only when present). Address: VERIFY partial-unique default per customer; ADD `{customerId,isDefault}` + `{customerId,updatedAt}` indexes; lat/lng paired validator (both or neither).

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| my cart list | NEW {customerId,updatedAt:-1} | lean + populate batched (avoid per-item N+1: single $in fetch services+products) |
| add upsert | unique triple ✓ | use updateOne $inc upsert (atomic, no pre-read) |
| default address | partial-unique (verify) | single findOne lean |
| checkout validate | batched $in (services, products, mappings) | no per-line awaits in loop |

N+1: `getMyCart` bulk-populates — verify batched (fix to $in if per-item).

## 9. Concurrency Findings

- Concurrent adds same triple: use `updateOne({triple}, {$inc:{quantity}, $setOnInsert:{...}}, {upsert:true})` → exactly-once. No Redis.
- Concurrent checkout ×2: both read cart → double bookings. Fix: checkout claims cart (`findOneAndUpdate Claimed` flag or delete-with-return in txn) — second gets 409 CART_EMPTY/CHECKOUT_IN_PROGRESS. Add `cartCheckoutLock` via atomic state or idempotency key (`clientRequestId` header/body → stored on created bookings group).
- setSchedule vs checkout race: checkout re-validates slot (TOCTOU closed by re-check inside txn).

## 10. Transaction Findings

- Checkout (bookings + quote-requests + cart-clear): multi-doc → SINGLE txn (services + requests + cart delete). Verify current scope; extend if partial. External broadcast stays post-commit (M6 outbox pattern).
- Add/update/remove/schedule/default: single-doc → NO txn.

## 11. Outbox / Worker Findings

None owned. Checkout commits business docs; M6 BookingOutbox + M7 quotation flow take over post-commit. Cart-clear inside same txn (no separate outbox needed).

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| add | triple + $inc | replay → qty++ (intended; client controls) — for strict once, clientRequestId per add (optional, skip) |
| checkout | clientRequestId (NEW header/body, stored on booking group/paymentGroupId) | replay same key → return prior result, no new bookings |
| setSchedule | last-wins | replay safe |
| remove/clear | idempotent delete | replay → 200/404 both OK (return 200) |

## 13. API Contract Findings

REST-smells (`/cart/my-cart`, `/cart/removed/:id`, PUT /cart/update vs PUT /cart/:id) — keep (compat), document. Add `Idempotency-Key` header on POST /checkout (new, optional). Codes: 400 empty cart, 409 checkout-in-progress/dup-key, 422 slot/zone invalid with reason codes, 429 none (global limiter suffices).

## 14. Target Architecture

```text
Route (Auth) → Validator → Controller-thin → Service (cart.service, address.service, checkout.service)
 → M6 bookingService + M7 quoteRequestService (delegated, not duplicated) → Mongo (txn at checkout)
```

## 15. Target Schema

Cart: KEEP + qty cap + claimed/idempotency fields (ADD `checkoutKey`, `status: active|checking-out` default active). Address: KEEP + paired-validator + indexes. Snapshot: DERIVED via `buildAddressSnapshot()` (never stored divergently).

## 16. Target Query Design

Atomic upserts, batched populates, single-txn checkout fan-out, lean reads, explain-verified triple + customer indexes.

## 17. Target File Structure

```text
modules/cart-address/
├── routes/cart.routes.js | address.routes.js (same paths)
├── controllers/cart|address|checkout.controller.js (thin; checkout delegates)
├── services/cart.service.js | address.service.js | checkout.service.js  # NEW checkout service
├── repositories/cart.repo.js | address.repo.js
├── validators/cart-address.validator.js  # NEW
└── tests/...
```

## 18. State Machine

Cart line: `active → scheduled? → checked-out(cleared) | removed`. Checkout: `idle → claimed → committed(→ M6/M7 own machines) | failed(release claim)`. Address: `created ⇄ default ↔ non-default → deleted` (default deletes reassign default to newest — define + test).

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Double checkout click | one booking set, second returns same | possible dup | Idempotency-Key → same result |
| Concurrent adds | qty exact | racy | atomic $inc |
| Slot invalid at add | 422 now | allowed → fails later | fail fast + re-check |
| Zone unmapped at add | warning now, block at checkout | silent → block later | warn + block later |
| Product + service mix | both created atomically | verify txn | single txn |
| Empty cart checkout | 400 | 400? | 400 CART_EMPTY |
| Address deleted mid-checkout | 422 | ? | re-resolve inside txn → 422 |

## 20. Test Plan

Unit (slot validator, snapshot normalizer); integration (checkout txn rollback); API (all endpoints + IDOR matrix + pagination of cart? small — cap 100); concurrency (double-add qty exact, double-checkout single set); idempotency (same key replay); security (ownership, mass-assignment); failure (M6 pipeline down → 503, cart intact); regression (response shapes); load (checkout burst with mocked downstream).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (checkout shape, IDOR). P3 additive indexes + checkoutKey. P4 delegate checkout to M6 pipeline + atomic add + fail-fast validation (compat same routes). P5 Idempotency-Key support. P6 deprecate alias routes. Rollback: redeploy; additive-only.

## 22. Production Verification Checklist

Code (single build path via M6, no inline booking writes); DB (uniques/indexes/explain, no unbounded); Security (ownership matrix, validators); Reliability (checkout txn + idempotency, no outbox owned); Observability (checkout latency, BLOCK-by-reason, cart-size metric); Tests green; Deployment (compat, rollback).

## 23-26. Files

- Create: validators, repos, checkout.service, tests.
- Modify: cartController (delegate + atomic + fail-fast), addressService (normalizer), routes (docs only).
- Merge: none. Delete: alias routes post-migration (P6).

## 27. Risks / Open Questions

Default-address reassignment policy on delete (newest?) — product call. Idempotency-Key adoption needs mobile change — optional first (server still safe via claim flag). Cross-module: M3 (zone gate), M4 (item refs), M6 (booking pipeline — FROZEN contract), M7 (quote-request create), M11 (checkout notifications via M6/M7, not M5).

## 28. Final Acceptance Criteria

Fail-fast validation live; checkout delegates to M6; double-click safe; IDOR matrix green; txn atomic; indexes verified; tests green.

### Can this module safely be rewritten now?

```text
YES
```

Conditions: checkout delegation contract joint-reviewed with M6/M7; IDOR tests first. Must NOT break: M3 gate, M4 refs, M6 pipeline inputs, M7 request creation.
