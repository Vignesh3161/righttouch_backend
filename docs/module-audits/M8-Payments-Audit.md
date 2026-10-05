# M8 — Payments (Razorpay In): Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8 · Provider: Razorpay (orders + webhooks) · Money: paise truth
> Scope: ONLY M8 (collect customer money). Settlement/wallet/payout → M9; refunds → M10.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M8 copies the booking's immutable paise snapshot into `Payment(pending)` + Razorpay order, then succeeds via fast HMAC `verifyPayment` or authoritative `razorpayWebhook payment.captured` (with `PaymentEvent` dedupe + amount guard), posting `customer_payment/technician_earning_liability/platform_commission` ledger lines and flipping `booking.paymentStatus=paid`. Variants: ₹0 `free` instant success, admin offline success + receipt, manual override, settlement retry, plus `PaymentAttempt` lifecycle (expiry sweeper), reconciliation crons, and a customer read-model. Core pattern is sound (snapshot-copy, dedupe, dual-path verify), but `itemType`+`paymentType` duplicate enums, `bookingId ref:ServiceBooking` blocks product FKs, `Payment.bookingId` unique complicates retries (split across attempt table — undocumented), and offline/cash lacks maker-checker. Verdict: **YES WITH CONDITIONS** — unify item typing with refPath, document the 1:1 + attempt-split, gate offline with two-person rule, all in one additive release.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/Payment.js` | Per-booking payment + paise snapshot copy + provider ids (unique partials) + idempotencyKey + capturedAmountPaise + lastAttemptId + amountRefundedPaise + legacy rupees + status pending\|success\|failed\|refunded\|manual_review | paymentController, settlement, refund (reservation), finance | Booking snapshot | YES (payment truth) | REMAIN, unify typing |
| `Schemas/PaymentAttempt.js` | Per-checkout in-flight attempt created\|authorized\|captured\|failed\|expired + idempotency/expiry | initiate/retry, sweeper | Payment | YES | REMAIN |
| `Schemas/PaymentEvent.js` | Raw webhook dedupe by eventId unique | razorpayWebhook | — | YES | REMAIN |
| `Schemas/Receipt.js` | Receipt per success | settlement/paymentSettlementService | — | YES | REMAIN |
| `Controllers/paymentController.js` | createPaymentOrder (snapshot copy), verifyPayment (HMAC), razorpayWebhook (authoritative + dedupe + amount guard), offline + manual override, retryPaymentSettlement, getters | User.js payment routes, webhooks | Razorpay, ledger, Booking | YES | REMAIN, split webhook handler |
| `Controllers/customerPaymentController.js` | Customer read-model: list/summary/detail/receipt/refunds, initiate/retry/declareCash | customerPayments routes | paymentReadModel, Payment | YES (read surface) | REMAIN |
| `Services/paymentSettlementService.js` | Product/quote settlement: mark paid + ledger + receipt + stock decrement | quote accept/pay | ledger, Product | YES | REMAIN |
| `Utils/razorpay.js` | Provider client | controller, engine | Razorpay API | YES | REMAIN |
| `Utils/paymentTransitions.js` | Transition guards | controller, crons | — | YES | REMAIN, single gate |
| `Utils/paymentAttempts.js` | Attempt lifecycle | initiate/retry/verify | Attempt | YES | REMAIN |
| `Utils/paymentReadModel.js` | Customer list/summary builders | customerPaymentController | Payment, Refund | YES | REMAIN |
| `Utils/paymentCrons.js` | 15m reconcile + settlement backstop, 10m payout reconcile, 6h auto-payout, daily ledger audit | startBackgroundWorkers | Payment, ledger | YES | REMAIN |
| `Utils/attemptExpirySweeper.js` | Expire stale attempts | workers | Attempt | YES | REMAIN |
| `Utils/paymentNotificationWorker.js` | Realtime payment-status pushes | workers | notify (M11) | YES | REMAIN |
| `Utils/money.js`, `receiptService.js` | Paise helpers, receipt builder | everywhere money | — | YES | REMAIN |
| `Routes/customerPayments.js` | `GET /,/summary,/:bookingId[/receipt|/refunds]`, `POST /:bookingId/order|/retry|/cash/declare` (limited) | index.js /api/user/payments | customerPaymentController | YES | REMAIN |
| `Routes/User.js` payment subset | legacy order/verify/webhook/status/retry endpoints | index.js /api/user | paymentController | PARTIAL (legacy dup) | MERGE into customerPayments/admin |
| `Routes/adminPaymentRoutes.js` | product-payments list/summary, record-offline, :id/status override, booking fetch, booking delete | index.js /api/admin/payments | paymentController | YES | REMAIN |

## 3. Actual Current Flow

```text
Initiate: POST /:bookingId/order → load booking + financialSnapshot → Payment.create(pending, snapshot copy,
 idempotencyKey, lastAttemptId→Attempt.created) → Razorpay order → Response{orderId, amount}
Success fast: POST /payment/verify {orderId,paymentId,signature} → HMAC check → capturedAmount vs totalAmount
 → match: markPaymentSucceeded → ledger(customer_payment + liability + commission) → booking paid + receipt + notify
 → mismatch: manual_review + ReconciliationException
Success authoritative: Razorpay → POST /payment/webhook/razorpay → verify signature (rawBody HMAC)
 → PaymentEvent.findOne(eventId)? dup→200 : create → apply same markPaymentSucceeded (idempotent)
Variants: total==0 → free instant success; recordAdminOfflinePayment → offline success + ledger + receipt;
 updatePaymentStatus (Admin/Owner audited) → manual override; retryPaymentSettlement → backstop credit (M9 settle does wallet part)
Failure: HMAC fail → 400; amount mismatch → manual_review; provider fail → Payment failed + Attempt failed → retry allowed
Attempt expiry: sweeper → expired (new order allowed). Reconcile cron heals stuck pending vs provider state.
```

Duplicate-request: webhook retried by Razorpay → eventId dedupe → 200 same. Concurrent: verify + webhook same payment → idempotent succeed (second is no-op 200). Partial: ledger lines in same success txn (verify scope). Recovery: retry endpoint + cron backstop. Admin: offline record, status override (audited), booking delete (dangerous — §5).

## 4. Business Rules & Invariants

1. **Payment amounts are a COPY of the booking snapshot, never recomputed.** Enforcement: copy at order create (good). KEEP + test (mutate catalog after order → payment unchanged).
2. **One successful payment per booking (no double-charge effect).** Enforcement: Payment.bookingId unique + idempotent succeed (good). KEEP; document attempt-split (retries create Attempts, not Payments).
3. **capturedAmount must equal totalAmount or human reviews.** Enforcement: mismatch → manual_review + exception (good). KEEP.
4. **Webhook is authoritative over client verify.** Enforcement: both apply same transition; webhook deduped (good). KEEP + document precedence (either may win; outcome identical).
5. **Offline/cash success requires two humans (maker+checker).** Enforcement: MISSING (single admin records). Solution: recordedBy + approvedBy distinct + receipt. DB: keep both fields, enforce distinct.
6. **Refunded amount never exceeds captured (reservation accounting).** Enforcement: amountRefundedPaise reserve (good). KEEP + test with M10.

## 5. Current Problems

- **P1 — Dual item typing (`itemType` lowercase vs `paymentType` UPPER) will drift.** Evidence: `Schemas/Payment.js:12-23`. Fix: single `itemType: SERVICE|PRODUCT|QUOTATION` + `bookingModel refPath` (migrate + alias).
- **P1 — `bookingId ref:ServiceBooking` blocks product/quote FK + populate lies.** Fix: `refPath: bookingModel` + enum.
- **P1 — Offline/cash single-admin success (no maker-checker).** Evidence: recordAdminOfflinePayment. Impact: insider fraud. Fix: two-person + audit + receipt mandatory.
- **P2 — `DELETE /booking/:id` (admin booking delete) sits in payment routes with money attached.** Impact: history destruction. Fix: forbid delete when Payment exists (or soft-cancel + refund path); move route.
- **P2 — Legacy + new payment routes duplicate (`/payment/order` vs `/:bookingId/order`).** Fix: canonicalize (keep both one release, deprecate legacy).
- **P3 — `updatePaymentStatus` manual override power too broad (any→any?).** Fix: allowlist transitions via paymentTransitions gate + audit (verify current gate; add if missing).

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P0 | Webhook forgery → fake paid | forged captured event | HMAC via rawBody (verify!) | free services | keep + test wrong-secret 400 | webhook sig test |
| P1 | Single-admin offline paid | rogue admin marks paid, pockets cash | one-step | fraud | maker+checker distinct + audit | two-admin test |
| P1 | Amount tamper | client alters order amount | server snapshot (verify) | underpay | assert server-side only | tamper test |
| P2 | Replay verify | resend same paymentId | idempotent succeed (good) | — | KEEP + test | replay test |
| P2 | bookingId IDOR | user pays another's booking | ownership check? verify | pay-for-other (low harm) / info leak | owner-or-admin | IDOR test |

Confirm rawBody capture precedes JSON parse for webhook routes (index.js order — verified present; keep + regression test).

## 7. Database Findings

Payment: UNIFY typing + refPath; KEEP unique bookingId (1:1) + provider uniques + idempotencyKey index; ADD `{status,createdAt}` (exists ✓ per schema) + `{status,reconciliationAttempts}` (exists ✓). Attempt: ADD `{paymentId,status}` + TTL on expiresAt (verify exists). Event: KEEP eventId unique + TTL (add 30d to bound growth — currently unbounded?). Receipt: ADD `{paymentId}` unique.

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| payment by booking | bookingId unique ✓ | KEEP lean |
| webhook dedupe | eventId unique ✓ | KEEP; add TTL 30d |
| reconcile sweep | {status,createdAt} ✓ + {status,reconciliationAttempts} ✓ | KEEP; batch 100 |
| attempt expiry | expiresAt TTL (verify) + {paymentId,status} NEW | sweeper explain |
| my payments list | NEW {customerId?,...} — NOTE: Payment has no customerId! Derive via booking join or ADD customerId denorm (SNAPSHOT at create — recommend ADD + index {customerId,status,createdAt desc}) | ADD field + index + backfill |
| admin product-payments | filter by itemType/status | NEW {itemType,status,createdAt desc} |

N+1: read-model joins Payment→Booking→Refund per row — batch via $in.

## 9. Concurrency Findings

- Verify + webhook same payment concurrently: both attempt markPaymentSucceeded → must be single atomic conditional (`findOneAndUpdate({_id,status:'pending'})`); loser no-op 200. VERIFY current atomicity; add if read-then-write.
- Double order click: two Payments? bookingId unique → second 11000 → catch → return existing order (200). Add catch (idempotent initiate).
- Retry vs webhook race: same conditional gate covers. No Redis (DB conditional suffices).
- Cron backstop vs live success: conditional on pending only. Good (verify filter).

## 10. Transaction Findings

- markPaymentSucceeded (Payment→success + booking→paid + ledger lines + receipt + amountRefunded init): multi-doc → ONE txn (verify scope; ledger postLedgerEntry must accept session — confirm, else split: money docs in txn, notify/receipt-best-effort post-commit).
- Order create (Payment + Attempt): ONE txn (verify; add if separate).
- Offline record: same success txn + audit. Webhook apply: same. No txn for reads/sweeper.

## 11. Outbox / Worker Findings

No separate M8 outbox: webhook/request path commits synchronously; downstream effects (wallet settlement M9, notifications M11) are THEIR outboxes/workers reading committed Payment state (correct separation). Attempt sweeper + reconcile cron + notify worker all present and correct. Poison: stuck `manual_review` never auto-retried (correct — human queue) + dashboard surfacing via ReconciliationException (verify admin visibility).

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| order | bookingId unique (+ Idempotency-Key optional) | replay → return existing order 200 |
| verify | (orderId,paymentId) unique partials | replay → 200 same |
| webhook | eventId unique | replay → 200 deduped |
| retry | Attempt id per retry | each retry new attempt; success once (conditional) |
| offline record | bookingId unique | replay → 200 same |
| refund reservation (M10) | amountRefundedPaise atomic $inc with cap check | over-refund → 409 |

## 13. API Contract Findings

Keep canonical `POST /api/user/payments/:bookingId/order|/retry`, `GET .../receipt|/refunds`, `GET / + /summary`; deprecate legacy `/payment/order|/verify` flat paths one release. Webhook: no auth (HMAC) + must ignore global JSON-error shape (rawBody intact — verify). Codes: 402? No — use 409 PAYMENT_REQUIRED-state conflicts (already-paid → 409 ALREADY_PAID + return receipt); 400 bad signature; 422 amount mismatch is NOT client error — internal 200-webhook + manual_review (correct: ack provider to stop retries, flag internally).

## 14. Target Architecture

```text
Route (Auth / webhook-HMAC) → Validator → Controller-thin → Service (payment.service: order|verify|webhook-apply|offline|retry)
 → paymentTransitions (sole gate) → Repository → Mongo (txn success path) → post-commit: receipt + notify (best-effort) + M9/M10 hooks read committed state
```

## 15. Target Schema

Payment: UNIFY `itemType` (MIGRATE values) + ADD `bookingModel refPath` + ADD `customerId` snapshot + keep uniques; Attempt: ADD indexes; Event: ADD TTL; Receipt: ADD unique. Mark NEW/KEEP/MIGRATE per field in migration script.

## 16. Target Query Design

All hot paths single indexed reads; success path conditional update (no read-then-write); lists lean + paginated + batched joins; sweeps batched + explain-verified.

## 17. Target File Structure

```text
modules/payments/
├── routes/customer-payments.routes.js | admin-payments.routes.js | webhook.routes.js (split, same paths)
├── controllers/* (thin)
├── services/payment.service.js | settlement-product.service.js (keep) | read-model.service.js
├── domain/payment.transitions.js  # NEW sole gate (extract existing)
├── repositories/payment|attempt|event.repo.js
├── validators/payment.validator.js # NEW
└── tests/...
```

## 18. State Machine

```text
Payment: pending → success → refunded (via M10 reservation→full) | pending → failed → pending (retry creates Attempt; Payment row reused — document!) | any → manual_review → success|failed (admin)
Attempt: created → authorized → captured | → failed | → expired
```

Who: customer (order/retry/declare), provider webhook (capture), system (sweeper/cron), admin (offline/record/status-override within allowlist). Concurrent protection: conditional status updates everywhere.

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Double-click order | one order returned twice | maybe 500 | catch dup → 200 existing |
| Webhook before verify | success via webhook; verify → 200 same | idempotent? | conditional → same |
| Amount mismatch | ack 200 + manual_review | ? | 200 + flag + alert |
| ₹0 order | instant success, no provider call | exists | KEEP + test |
| Retry after success | 409 ALREADY_PAID + receipt | ? | 409 + receipt |
| Provider down at order | 503 + Attempt failed, retry allowed | ? | 503 + test |
| Offline without approval | 403 until second admin | single-step | two-person |
| Delete booking w/ payment | 409 | deletable? | block + test |

## 20. Test Plan

Unit (transitions, snapshot-copy, amount-compare); integration (success TXN incl. ledger+receipt, rollback); API (all routes × roles, IDOR, codes); transaction (kill mid-success → rollback, webhook replay → single success); concurrency (verify+webhook race, double order); idempotency (replay table); security (forged webhook, tampered amount, single-admin offline); failure (provider down, Mongo down → 503); regression (shapes); load (webhook burst 1000 deduped — measure).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (success shape, dedupe, snapshot-copy). P3 additive fields/indexes (customerId backfill, refPath, TTL) background. P4 unify typing (dual-write compat) + conditional success + dup-order catch + maker-checker offline + route canonicalization. P5 dual-read compat. P6 migrate old enum values + backfill customerId. P7 shadow (compare old/new success outcomes log-only). P8 enforce + deprecate legacy paths. P9 monitor (success rate, mismatch rate, webhook lag). P10 remove legacy + old fields. Rollback: redeploy; additive until P6 (backup).

## 22. Production Verification Checklist

Code (single transition gate, no direct status writes); DB (uniques/TTL/explain/pagination/backfill); Security (HMAC, two-person, IDOR, tamper); Reliability (conditional success, TXN, dedupe, sweeper, reconcile); Observability (requestId/paymentId/orderId/eventId logs, success/mismatch/dup metrics, webhook lag); Tests green; Deployment (background indexes, compat, rollback).

## 23-26. Files

- Create: domain/payment.transitions.js, validators, repos, webhook split, tests, backfill scripts.
- Modify: schemas (typing/refPath/customerId/TTL), paymentController (conditional + catch + allowlist), customerPaymentController (batched joins), routes (canonical+deprecate), read-model (customerId index).
- Merge: legacy User.js payment subset INTO customer/admin payment routes (keep paths one release).
- Delete: legacy dup paths (P10); `DELETE booking` admin route (replace with guarded flow).

## 27. Risks / Open Questions

bookingId-unique vs future split-payments/part-payments — confirm single-charge model stays (yes today). `paymentStatus=partial` (M7) interplay — define or drop jointly. Cross-module: M6/M7 (snapshot source + paid hooks), M9 (settle consumer — frozen success contract), M10 (reservation fields — joint), M11 (status pushes), M12 (finance reads).

## 28. Final Acceptance Criteria

Snapshot-copy pinned; double-order/webhook/verify exactly-once; mismatch → manual_review + ack; offline two-person; no direct status writes; indexes verified; tests green; migration clean.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: typing migration alias-safe; conditional-success + dup-catch + maker-checker in one release with shadow; storm/dedupe suite green. Must NOT break: M6/M7 paid transitions, M9 settle + ledger contract, M10 reservation fields, M11 notify payloads.
