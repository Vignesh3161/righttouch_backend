# M10 — Refund / Complaint-Hold / Disputes: Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8 · Rails: razorpay_reverse + razorpayx_payout · Money: paise truth
> Scope: ONLY M10. Intake/complaint lifecycle text → M12; settlement/wallet → M9; payment capture → M8.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M10 returns customer money with full accounting: `adminPreview` (net=`gross−material`, clawback=`net×techShare×sharePct`, commission reversal, MDR loss, processing fee, GST recoverable) → `createRefund` (atomic `amountRefundedPaise` reservation + `refundClawback` cascade `ReserveHold→reserve/available→outstandingDues` + `customer_refund/commission_reversal/mdr_loss/processing_fee` ledger + `CreditNote` + `RefundOutbox(new)`) → `refundWorker/executeRefund` (Razorpay reverse normal/optimum or manual X payout) → webhook + `reconcileRefunds`; failures `reverseClawback` + reservation revert; over-limit second-admin; `Chargeback`/`ReconciliationException` for disputes/mismatches; `complaintFreeze` (`ReserveHold→frozen` + `BookingPayoutBlock`) + `classARefundScanner` + `complaintSlaEscalation`. Well-architected; gaps: product paid-cancel never creates Refund (M7 link missing), `cancellationFeeStatus=not_collected` has no collector, fault/share math split between `refundEngine` and `refundClawback`, and rail selection criteria are implicit. Verdict: **YES WITH CONDITIONS** — unify the calculator, wire paid-cancel triggers, define rail policy, in one release with shadow allocation compare.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/Refund.js` | Full-breakdown refund (gross/breakdown/material/net, clawback×4, commissionReversed, mdrLoss, processingFee, gstRecoverable, creditNoteId, rail/speed, providerRefundId unique, status 7-state, attempts, awaitingApproval, idempotencyKey unique) | refundController, engine | Payment, Report, CreditNote | YES | REMAIN |
| `Schemas/RefundOutbox.js` | new\|processing\|done\|failed execution queue | engine | — | YES | REMAIN |
| `Schemas/CreditNote.js` | GST credit note + deadline/declared | engine | — | YES | REMAIN |
| `Schemas/Chargeback.js` | open\|under_review\|contested\|won\|lost + evidence | webhooks/admin | — | YES | REMAIN |
| `Schemas/CustomerRefundPayout.js` | Manual X customer payout path | adminCreateCustomerPayoutRefund | RazorpayX | YES | REMAIN, define rail policy |
| `Schemas/ReconciliationException.js` | Fingerprint-deduped inconsistency surfacing | engine, payment mismatch | — | YES | REMAIN |
| `Controllers/refundController.js` | preview/create/approve(second-admin)/retry/customer-payout/list + tech my-refunds | adminRefunds + technicianRefunds routes | engine, policy | YES | REMAIN, split preview vs execute |
| `Utils/refundEngine.js` | computeRefundAllocation + createRefund + refundWorker/executeRefund + reconcileRefunds + classARefundScanner + complaintSlaEscalation | controller + crons (30s/5m/2m/1h) | policy, clawback, ledger, Razorpay, notify, audit | YES (keep!) | REMAIN, extract calculator |
| `Utils/refundPolicy.js` | Tunables from GlobalSetting (MDR, dual-approval, windows, ClassA/B) | engine | GlobalSetting | YES | REMAIN |
| `Utils/refundClawback.js` (+reverse) | Cascade ReserveHold→reserve/available→dues + reversal | engine | walletDebit, ReserveHold | YES | REMAIN, merge calculator here-or-engine (one place) |
| `Utils/complaintFreeze.js` | freezeForComplaint/releaseOnResolution/releaseExpiredHolds | complaintService (M12), engine | ReserveHold, BookingPayoutBlock | YES | REMAIN |
| Routes | adminRefunds (refunds + complaints-admin subset), technicianRefunds (my-refunds + categories) | index.js | controllers | YES | REMAIN |

## 3. Actual Current Flow

```text
Preview: POST /refunds/preview {paymentId|bookingId, class, faultParty, sharePct, reason} → computeRefundAllocation
 → {net, clawback, commissionReversal, mdrLoss, fee, gstRecoverable} (no writes)
Create: POST /refunds → createRefund: atomic Payment.amountRefundedPaise reservation (cap-checked)
 → applyClawback cascade → ledger 4 lines → CreditNote → RefundOutbox(new) → Response{refundId}
 → over-limit → awaitingApproval (second admin POST /:id/approve)
Execute: refundWorker (30s) claims new → executeRefund: rail razorpay_reverse (normal|optimum speed)
 → providerRefundId + initiated → webhook → processed ( reconcileRefunds finalizes booking/payment states )
 → fail → retrying (backoff) → exhausted → failed/manual_review + reverseClawback + reservation revert + alert
Manual rail: POST /:id/customer-payout → CustomerRefundPayout via RazorpayX (unreversible source) + same books
ClassA: classARefundScanner (2m) auto-creates qualifying refunds; SLA escalation (1h); freeze expiry (15m)
Disputes: Chargeback open→…→won/lost + evidence; mismatches → ReconciliationException (admin queue)
```

Failure: provider fail → retry/backoff → failed + reversal (no money moved without books). Timeout: webhook loss → reconcile heals. Cancel: N/A (terminal processed; failed may re-queue via retry). Dup: idempotencyKey + providerRefundId unique. Concurrent: double-create same payment → reservation cap atomic (second 409). Partial: clawback-partial tracked (applied vs required) + dues remainder. Admin: approve/reject, status updates, category list.

## 4. Business Rules & Invariants

1. **Every paid-cancel/adjudicated complaint moves money ONLY via Refund (never silent status flip).** Current: M7 paid-cancel bypasses. Fix: triggers (M6/M7 paid-cancel, M12 resolved_refunded) → createRefund. Enforce by removing direct `paymentStatus=refunded` writes elsewhere.
2. **Refunded ≤ captured (reservation cap).** Enforcement: atomic reservation (good). KEEP.
3. **Clawback never exceeds technician liability; shortfall → outstanding dues (aged, visible).** Enforcement: cascade + toDues (good). KEEP + aging report.
4. **Commission reverses proportionally; MDR/fee booked as platform loss (explicit, audited).** Enforcement: lines posted (good). KEEP.
5. **Over-limit refunds need two distinct admins (maker≠checker + reason).** Enforcement: awaitingApproval (good). KEEP + distinctness test.
6. **A refund executes exactly once per rail (provider idempotency).** Enforcement: providerRefundId unique + outbox (good). KEEP.
7. **GST-recoverable refunds always mint CreditNote before deadline.** Enforcement: creation path (good). KEEP + deadline alert.

## 5. Current Problems

- **P0 — Paid-cancel paths (M6 service, M7 product) don't create Refunds (money dangles).** Fix: triggers in same release (joint M6/M7/M12).
- **P1 — Calculator split (engine vs clawback) risks divergent math.** Fix: single `refundCalculator` pure module (net/clawback/reversal/MDR/fee/GST) used by preview + create + tests.
- **P1 — `cancellationFeeStatus=not_collected` has no collector/reconciler.** Fix: define collection (wallet hold vs payment intent) with M9 or waiver flow + aging job; else stop recording fiction.
- **P2 — Rail selection (reverse vs X payout) implicit.** Fix: explicit policy (reversible → reverse; unreversible/cash → X payout + dual approval) + tests.
- **P2 — Speed normal|optimum cost/settlement-time tradeoff undocumented.** Fix: document + default normal, optimum needs reason.
- **P3 — Complaint-admin routes live under adminRefunds (module blur with M12).** Keep (works); document ownership: intake/status in M12, money in M10.

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P1 | Single-admin large refund | rogue admin refunds to accomplice | dual over-limit (good) | theft | enforce distinct + amount-tiered limits | two-admin test |
| P1 | Refund-to-wrong-destination | rail tampering | provider-linked refund (good for reverse) | misdirection | X-payout needs verified beneficiary + dual | beneficiary test |
| P2 | Double refund same payment | double create | reservation cap (good) | over-refund | KEEP + concurrency test | storm test |
| P2 | Complaint→refund without adjudication | auto-scan misclassifies | ClassA policy (review) | wrongful payout | pin ClassA criteria + audit | policy test |

## 7. Database Findings

Refund: KEEP all + ADD `{status,nextAttemptAt}` for worker + `{bookingId,createdAt}` (exists ✓ per schema: bookingId index) + `{customerId,status}` for my-refunds. Outbox: ADD lease fields (verify present). CreditNote: ADD `{refundId}` unique + deadline index. Chargeback: ADD `{status,updatedAt}`. Reservation accounting on Payment (`amountRefundedPaise`) owned jointly with M8 — keep + cap-check in same atomic update.

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| worker claim | NEW {status,nextAttemptAt} partial pending-ish | batch 25 (current) + lease |
| my refunds (tech) | NEW {technicianId,status,createdAt desc} | paginate |
| admin queue | NEW {status,createdAt} + awaitingApproval | paginate + filter |
| reservation cap | atomic $inc with $lte guard on Payment | single update, no read-then-write (verify) |
| aging dues | {toDues>0, updatedAt} report query | NEW sparse partial |

## 9. Concurrency Findings

- Double create same payment: atomic reservation-cap → one wins (good, no Redis). Test storm.
- Worker double-claim: lease claim (verify filter `status:new + lease expired-or-null`) → exactly one. Test dual-worker.
- Webhook + reconcile race: conditional terminal transitions (verify expected-status filters).
- reverseClawback vs new clawback same tech: walletDebit atomic per txn; ordering serialized by worker claim (acceptable).

## 10. Transaction Findings

- createRefund (reservation + clawback + ledger×4 + credit-note + outbox + refund row): ONE txn (verify all inside; ledger session threading — fix if outside).
- executeRefund provider call: OUTSIDE txn (saga: outbox processing → provider → finalize txn). Keep.
- finalize (refund status + provider ids + booking/payment states): ONE txn (verify).
- failure path (reverseClawback + revert + failed status): ONE txn (verify).

## 11. Outbox / Worker Findings

Pattern correct (new→processing→done/failed, 30s worker batch 25, reconcile 5m, backoff, lease, poison→manual_review). Verify numbers: maxAttempts, backoff curve, lease TTL vs 30s interval, dead-letter surfacing (ReconciliationException? admin queue?). ADD alerting on `failed` + aging `retrying`.

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| preview | none (read-only) | replay safe |
| create | idempotencyKey unique + reservation cap | replay same key → return existing 200/409 with existing id |
| approve | conditional awaitingApproval→approved | replay → 200 same |
| execute | outbox claim + providerRefundId unique | replay → same |
| retry | conditional failed→processing | replay safe |
| webhook | provider refund id | deduped 200 |

## 13. API Contract Findings

Keep routes. Request: class/reason/faultParty/sharePct validated against policy (ClassA/B reasons). Response: allocation breakdown on preview AND create (transparency). Codes: 409 OVER_REFUND/ALREADY_REFUNDED/RACE_LOST; 403 approval-required (return 202 ACCEPTED with awaitingApproval instead? Decide: 202 + status — document); paginate lists.

## 14. Target Architecture

```text
Route (Auth + authorizeRoles) → Validator (policy-checked) → Controller-thin (preview vs execute split)
 → Service (refund.service: preview|create|approve|retry|payout) → Calculator (pure) → Repository → Mongo (txn)
 → RefundOutbox (same txn) → Worker → Provider rail → Webhook → Finalize txn → notify (M11) + audit
Triggers IN from M6/M7/M12 (paid-cancel/resolved_refunded) — same create path, never direct writes.
```

## 15. Target Schema

KEEP all; ADD worker/my/admin indexes; CreditNote refund-unique; enforce history immutability (no updates to processed refunds except status terminal transitions via service).

## 16. Target Query Design

Claim-based worker reads; atomic reservation; batched admin queues; explain-verified; no per-row N+1 (batch ledger-entry fetch where needed).

## 17. Target File Structure

```text
modules/refunds/
├── routes/admin-refunds.routes.js | technician-refunds.routes.js (same paths)
├── controllers/refund.controller.js (thin; preview vs execute split)
├── services/refund.service.js (same logic, calculator extracted)
├── domain/refund.calculator.js  # NEW pure math (single truth)
├── repositories/*.repo.js
├── validators/refund.validator.js # NEW (policy-checked)
├── workers/refund.worker.js (moved, same logic + lease verify)
└── tests/...
```

## 18. State Machine

```text
Refund: pending_execution → initiated → processed (terminal)
  → failed → retrying → initiated | → manual_review → processed|failed (admin)
  + awaitingApproval gate: created --over-limit--> awaitingApproval → approved → initiated
Booking/Payment side-effects via finalize txn only (no direct writes elsewhere).
Freeze (complaint-scope): none → frozen → released (resolution/withdraw/expiry) — owned logic in complaintFreeze, used here.
```

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Double create storm | one refund, rest 409+existing id | cap (good) | KEEP + test |
| Provider success, webhook lost | reconcile → processed | heals? | verify + test |
| Partial clawback (tech broke) | dues remainder + aging | toDues | KEEP + report |
| Unreversible source | X payout rail + dual | path exists | policy + test |
| Over-limit single admin | 202 awaitingApproval | ? | enforce distinct second |
| Paid-cancel trigger | auto-create draft/pending_execution | missing | ADD triggers |
| Fee not_collected forever | collector or waiver | none | ADD job/policy |

## 20. Test Plan

Unit (calculator matrix: fault×share×material×GST tiers); integration (create/execute/finalize TXNs + reversal); API (roles, codes, IDOR tech sees own only); concurrency (double-create storm, dual-worker claim); idempotency (replay table); security (single-admin over-limit, rail tamper, double-refund); failure (provider down/timeout, webhook loss, worker crash mid-execute → lease recovery); regression (allocation outputs pinned); load (worker 25-batch at backlog 10k — measure).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (allocation goldens + triggers documented as failing until wired). P3 additive indexes background. P4 extract calculator (no behavior change) + add triggers (M6/M7/M12 call same create) + rail policy + fee-collector decision (single release). P5 shadow allocation compare 1 week. P6 enforce + deprecate direct-write paths elsewhere (grep + remove). P7 monitor (create→processed lag, clawback shortfall rate, over-limit queue). Rollback: redeploy; calculator extract is behavior-preserving; triggers flaggable.

## 22. Production Verification Checklist

Code (single calculator, single create path, no direct refunded writes elsewhere); DB (indexes/explain/immutability); Security (dual-approval, rail policy, IDOR); Reliability (reservation atomic, outbox+retry+reconcile+reversal verified); Observability (refund lag, clawback dues, fee-not_collected aging, audit on every money move); Tests green; Deployment (background indexes, flag-gated triggers, rollback).

## 23-26. Files

- Create: domain/refund.calculator.js, validators, repos, tests, fee-collector job (or waiver flow).
- Modify: refundEngine (extract calculator, keep flow), refundController (split + codes), schemas (indexes), triggers in M6/M7/M12 (call create — joint diffs).
- Merge: none (engine + clawback stay separate files, single calculator import).
- Delete: direct `paymentStatus=refunded` writes outside finalize (grep + remove); dead fee-fiction if waiver chosen.

## 27. Risks / Open Questions

Fee-collection mechanism (hold vs intent vs waiver) — PRODUCT+FUNDS decision required. Rail costs (optimum fee) — finance sign-off. ClassA auto criteria — support sign-off (wrongful payout risk). Cross-module: M6/M7 paid-cancel triggers + M12 resolved_refunded trigger (joint), M8 reservation fields (frozen), M9 clawback/dues/holds (joint), M11 notify, M12 intake/evidence.

## 28. Final Acceptance Criteria

Calculator goldens green; triggers live (paid-cancel → Refund); no silent refunded writes; storm → single refund; worker+reconcile verified; dues aging visible; fee path decided; tests green.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: calculator extraction behavior-preserving first with goldens; triggers + rail policy + fee decision ship jointly with M6/M7/M12; storm + reconcile suite green. Must NOT break: M8 reservation accounting, M9 dues/hold writes, M12 complaint linkage, M11 notify payloads.
