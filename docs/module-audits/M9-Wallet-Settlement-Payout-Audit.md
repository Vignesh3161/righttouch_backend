# M9 — Wallet / Settlement / Payout (RazorpayX Out): Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8 · Provider: RazorpayX · Money: paise truth, ledger-sourced
> Scope: ONLY M9 (platform hold → wallet liability → bank payout). In-money → M8; refunds → M10.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M9 converts `completed+paid` bookings into technician wallet liability (`settleBookingEarningsIfEligible`: `job:<id>/tip:<id>` idempotent credits + dues-first recovery + `technician_earning_liability` ledger), then into bank money via `requestWithdrawal` (`available→reserved` + debit + request) → shared `withdrawalPayoutEngine` (KYC/fingerprint/dues/complaint re-gates + `PayoutOutbox` + contact/fund/payout) → webhook finalize (`paid` → release + lifetime + `technician_payout` ledger / `failed` → reserve refund / timeout → `manual_review`), with admin manual/dual-approval (≥₹10k), threshold `autoPayout (6h)`, and reconcile crons (10m payouts, daily ledger). The engine-sharing is good; the critical flaw is **wallet mirrors on TechnicianProfile drifting from ledger truth**, plus unclear eligible→settled→reserved semantics and shortfall handling split between booking doc and reconciliation. Verdict: **YES WITH CONDITIONS** — declare ledger truth, reconcile-or-delete mirrors, pin settlement preconditions, in one release with shadow balance comparison.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/WalletTransaction.js` | Append-only ledger (job\|tip\|withdraw\|adjustment\|bonus\|penalty\|refund, idempotencyKey unique, one job-credit partial-unique) | settlement, withdrawal, penalty, refund clawback | Booking, Payment, Withdrawal | YES (wallet truth alongside ledger) | REMAIN |
| `Schemas/WithdrawalRequest.js` | pending→processing→paid\|failed\|manual_review + reserve refs + dual-approval + fingerprint | wallet controllers, engine | — | YES | REMAIN |
| `Schemas/PayoutOutbox.js` | initiated\|completed\|failed\|manual_review, idempotency=withdrawalId | engine | — | YES | REMAIN |
| `Schemas/PlatformLedgerEntry.js` | Typed append-only platform cash + idempotency | ledger.js posters (M8/M9/M10) | — | YES (platform truth — keep!) | REMAIN untouched |
| `Schemas/BookingPayoutBlock.js` | Per-booking payout gating | settlement/freeze | — | YES | REMAIN |
| `Schemas/ReserveHold.js` | Complaint-driven freeze (shared with M10) | complaintFreeze, clawback | — | YES | REMAIN |
| `Controllers/technicianWalletController.js` | wallet view, txns, payout-settings, requestWithdrawal (KYC-bank/floor/dues/complaint/cooldown gates), cancel, receipt, history | technicianWalletRoutes + legacy technician.js | engine inputs, WalletTransaction | YES | REMAIN, split request vs read |
| `Controllers/adminWalletController.js` | summary, approve/reject/pay, manual payout (dual), auto-payout config | adminWalletRoutes | engine | YES | REMAIN |
| `Controllers/financeController.js` | summary/breakdown/payments-ledger, per-tech detail, technician earnings | financeRoutes | WalletTransaction, Payment, Ledger | PARTIAL (reads mirrors?) | REMAIN, read ledger only |
| `Controllers/razorpayXController.js` + `razorpayXWebhookController.js` + `Utils/razorpayX.js` | contact/fund/payout wrapper + payout webhook finalize | routes, engine | RazorpayX API | YES | REMAIN |
| `Utils/settlement.js` | settleBookingEarningsIfEligible (paid+completed+success + snapshot match → job/tip split, tip 100% pass-through) | booking complete, retryPaymentSettlement, backstop cron | WalletTransaction, Profile balances, Ledger | YES (keep!) | REMAIN, pin preconditions |
| `Utils/ledger.js` | postLedgerEntry idempotent helpers | M8/M9/M10 posters | Ledger | YES | REMAIN untouched |
| `Utils/withdrawalPayoutEngine.js` | SHARED pipeline: re-gates + PayoutOutbox + payout + success/failure settle + notify | request/manual/auto approve paths | RazorpayX, Withdrawal, Outbox, Ledger | YES (keep!) | REMAIN untouched |
| `Utils/autoPayout.js` | Threshold pre-approved auto requests via engine | 6h cron | engine | YES | REMAIN |
| `Utils/walletDebit.js` | Atomic debit helper | penalty/clawback | WalletTransaction, Profile | YES | REMAIN |
| Routes | technicianWalletRoutes, legacy technician.js subset, financeRoutes (admin+tech), adminWalletRoutes, razorpayXWebhookRoutes | index.js | controllers | YES | REMAIN, deprecate legacy subset |

## 3. Actual Current Flow

```text
Settlement: completed+paid+Payment.success+snapshot-match → settleBookingEarningsIfEligible
 → split job=(technician−tip)+tip → WalletTransaction credit job:<bookingId>/tip:<bookingId> (idempotent)
 + Profile.availableBalance+=credit (dues recovered first) + Ledger:technician_earning_liability
 → retried via retryPaymentSettlement + 15m backstop cron
Withdrawal: requestWithdrawal validates KYC-bank, maintenance-floor, dues/complaint/active-payout/cooldown
 → atomic available→reserved + debit withdraw + WithdrawalRequest(processing)
Payout: engine re-gates KYC+fingerprint → PayoutOutbox(initiated, idem=withdrawalId) → contact/fund/payout
 → paid: settlePayoutSuccess (reserved release, lifetimeWithdrawn, technician_payout ledger, outbox completed, notify)
 → failed: reserve refund; timeout: manual_review
Admin: manual payout (≥₹10k dual-approval)/approve/reject/pay; autoPayout 6h (threshold, balance−floor, origin auto)
Heal: reconcileStuckPayouts 10m + reconcileDailyLedger + notify worker
```

Failure: KYC/bank unverified → 403/422; insufficient (floor/dues) → 409/422; RazorpayX fail → failed + reserve refund + retry allowed; timeout → manual_review queue. Retry: engine retryable pre-payout; post-payout-failed → new attempt row. Timeout: payout status polling + reconcile. Cancel: cancelMyWithdrawal (pre-payout only → reserve release). Dup: idempotency withdrawal:<id>, job:<id>. Concurrent: double-settle → unique backstop; double-withdraw → reserve atomic check. Partial: payout sent but webhook lost → reconcile heals. Admin: dual-approval over threshold + audit.

## 4. Business Rules & Invariants

1. **Ledger is platform truth; WalletTransaction is wallet truth; Profile balances are DERIVED read-model (or deleted).** Current: mirrors written as truth → drift. Fix §18 (KEEP dual-write one release with reconciler, then read-model).
2. **Settle only paid+completed+success+snapshot-match.** Enforcement: gate exists (good). KEEP + test each conjunct.
3. **One job-credit per booking; tip 100% pass-through.** Enforcement: partial-unique + split logic (good). KEEP.
4. **Withdrawal never exceeds available−floor−dues−holds.** Enforcement: request-time gates + engine re-gates (good). KEEP both (TOCTOU: re-gate inside payout txn).
5. **Payout state advances exactly once (paid XOR failed XOR manual_review).** Enforcement: outbox + conditional updates (verify). KEEP + test.
6. **≥₹10k manual payouts need two distinct admins.** Enforcement: dual-approval fields (good). KEEP + enforce distinctness.
7. **Dues recovered before credit; shortfalls stay receivable (outstanding), never silent.** Enforcement: split debited/policy fields (keep) + reconciliation job (verify scheduled).

## 5. Current Problems

- **P0 — Profile wallet mirrors vs ledger drift (no reconciler evident).** Impact: wrong balances → over/under payout. Fix: nightly `reconcileWalletMirrors` job NOW; then mirrors → read-model (or delete, compute from WalletTransaction on read).
- **P1 — eligible→settled→reserved semantics undocumented across booking/ledger/wallet.** Fix: state glossary + single `settlementStatus` writer (settlement.js only).
- **P1 — Penalty/shortfall split (booking doc fields vs outstanding vs reconciliation) unclear ownership.** Fix: single dues ledger + aging report.
- **P2 — Finance summaries may read mirrors instead of ledger.** Fix: point all finance reads at Ledger+WalletTransaction.
- **P2 — Legacy wallet subset routes duplicate technicianWalletRoutes.** Fix: deprecate legacy.
- **P3 — Maintenance-floor/threshold tunables scattered.** Fix: centralize in GlobalSetting (M12) with cache.

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P1 | Payout to unverified/changed bank | bank swapped post-request | fingerprint re-gate (good) | misdirected funds | KEEP + test swap-race | race test |
| P1 | Single-admin large payout | colluding admin | dual ≥₹10k (good) | theft | enforce distinct approvers + audit | two-admin test |
| P1 | Withdrawal over available (race) | double request same balance | atomic reserve check? verify | overdraft | conditional available>=amount update | concurrency test |
| P2 | Webhook forgery (payout status) | forged paid | signature verify? verify | false release | keep + test | sig test |
| P2 | Complaint-freeze bypass | withdraw during freeze | complaint gate (good) | evasion | KEEP + test | freeze test |

## 7. Database Findings

WalletTransaction: KEEP uniques + ADD `{technicianId,createdAt:-1}` (exists ✓ per schema) + `{withdrawalId,type}` (exists ✓). Withdrawal: ADD `{technicianId,status,createdAt desc}` + `{status,nextAttemptAt}` for reconcile. PayoutOutbox: ADD `{status,nextAttemptAt}`. Ledger: KEEP idempotency uniques; NEVER update/delete (append-only — enforce via app guard + comment). Profile mirrors: DEPRECATE (read-model; stop writing P-phase-2).

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| settle eligibility sweep | {paymentStatus,settlementStatus} + {settlementStatus,status,paymentStatus} ✓ (booking) | KEEP; batch 100; explain |
| my txns | {technicianId,createdAt:-1} ✓ | paginate |
| earnings summary | {technicianId,type,source} ✓ | aggregate (not N+1); precompute monthly rollup? (only if slow — measure) |
| withdrawal reconcile | NEW {status,nextAttemptAt} | batch claim |
| finance breakdown | Ledger {type,createdAt} NEW if missing | aggregate pipeline, no $unwind abuse |

## 9. Concurrency Findings

- Double settle same booking: unique job-credit → one wins; loser catches → no-op. Good, no Redis. Test.
- Double withdrawal same funds: reserve via conditional `available>=amount` update in txn; loser 409. VERIFY atomicity; add if read-then-write.
- Engine retry vs webhook finalize race: conditional outbox/status transitions (verify; add expected-status filter).
- Auto-payout vs manual request same cycle: active-payout gate (good) + unique active-withdrawal partial index (ADD: one processing per tech).

## 10. Transaction Findings

- Settlement (wallet credits + profile bump + ledger + booking settlementStatus): ONE txn (verify session threading through ledger poster; fix if ledger writes outside txn).
- Withdrawal request (reserve + debit + request): ONE txn (keep).
- Payout send (outbox + provider call CANNOT txn): outbox-initiated → provider → finalize conditional (correct saga; keep).
- Finalize (withdrawal status + reserve release/lifetime + ledger + outbox): ONE txn (verify; add if split).

## 11. Outbox / Worker Findings

PayoutOutbox pattern correct (initiated→completed/failed/manual_review, idempotent key, reconcile). Verify: backoff curve, maxAttempts, lease vs 10m reconcile, poison → manual_review (not infinite retry — good). Missing: stuck `processing` Withdrawal without outbox (e.g. crash between request and outbox) → reconcile must cover by withdrawal status too (verify filter; add).

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| settle | job:<bookingId>/tip:<bookingId> | replay → no-op 200 |
| withdrawal request | active-withdrawal unique + client key (add) | replay → return existing 200 |
| payout send | outbox idem=withdrawalId | replay → reuse provider payout id |
| finalize webhook | provider payout id unique | replay → 200 deduped |
| cancel withdrawal | conditional pre-payout | replay → 200 same |

## 13. API Contract Findings

Keep routes; add `Idempotency-Key` on POST withdrawal (new, optional). Paginate txns/history (verify). Codes: 409 INSUFFICIENT_FUNDS/HAS_ACTIVE_PAYOUT/DUES_BLOCKED with reason codes; 422 KYC/BANK_UNVERIFIED; 403 payoutBlocked.

## 14. Target Architecture

```text
Route (Auth + requireRole) → Validator → Controller-thin → Service (settlement.service — sole settlementStatus writer; withdrawal.service; payout.service→engine)
 → Repository → Mongo (txn: settle/request/finalize; saga: send) → PayoutOutbox → Engine → RazorpayX → Webhook → Finalize
 → post-commit: notify (M11) + audit
```

## 15. Target Schema

KEEP all; ADD reconcile indexes + active-withdrawal unique; Profile mirrors → DERIVED (stop-write P2); Ledger append-only guard. Document eligible (payable) vs settled (credited) vs reserved (held) once.

## 16. Target Query Design

Conditional updates + unique-catch everywhere; sweeps batched + indexed; summaries aggregated server-side with pagination; explain-verified.

## 17. Target File Structure

```text
modules/payouts/
├── routes/technician-wallet.routes.js | admin-wallet.routes.js | finance.routes.js | payout-webhook.routes.js (same paths)
├── controllers/* (thin; split request vs read)
├── services/settlement.service.js (sole writer) | withdrawal.service.js | payout-engine.service.js (keep logic)
├── domain/settlement.guards.js # NEW pinned preconditions
├── repositories/*.repo.js
├── validators/payout.validator.js # NEW
├── workers/reconcile-wallet-mirrors.job.js # NEW (then remove mirrors)
└── tests/...
```

## 18. State Machine

```text
Booking settlement: pending → eligible (M8 paid + M6 completed) → settled (wallet credited; terminal; sole writer settlement.service)
Withdrawal: pending → processing → paid (terminal) | failed (→ may re-request) | manual_review → paid|failed (admin)
PayoutOutbox: initiated → completed | failed | manual_review
Reserve: available ⇄ reserved → released (paid/failed/cancel) ; dues → outstanding (aged)
```

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Double settle | single credit | unique (good) | KEEP + test |
| Double withdraw | one 200, one 409 | ? | conditional + test |
| Bank swap mid-flight | abort + re-verify | fingerprint gate | KEEP + test |
| Payout timeout | manual_review + alert | exists | KEEP |
| Complaint during reserved | hold respected | gate | KEEP + test |
| Mirror drift | reconciler fixes + alerts | none | NEW job |
| ≥₹10k same-admin approve | 403 | ? | distinctness test |

## 20. Test Plan

Unit (split math, gates, distinct-approver); integration (settle/request/finalize TXNs); API (roles, codes, pagination); concurrency (double settle/withdraw, webhook+retry race); idempotency (replay table); security (bank-swap, freeze-bypass, webhook forgery); failure (RazorpayX down/timeout, Mongo down → 503, crash-between-outbox-and-send → reconcile); regression (balances shape during dual-write); load (settle sweep 10k eligible — measure).

## 21. Migration Plan

P1 audit DONE. P2 pin tests (balances from ledger vs mirrors — record drift NOW). P3 additive indexes + active-withdrawal unique background. P4 reconciler job + dual-write-verify mode + settlement-guard pinning (same routes). P5 shadow balance compare 1 week (alert on divergence). P6 stop mirror writes (read-model compute) — behind flag. P7 enforce. P8 monitor (settle lag, payout success, drift==0). P9 drop mirror columns (backup). Rollback: flag-off restores mirror writes; additive until P9.

## 22. Production Verification Checklist

Code (sole writers, no direct balance writes outside services); DB (uniques/indexes/explain/append-only); Security (bank gate, dual-approval, IDOR, webhook sig); Reliability (conditional + TXN + outbox + reconcile + reserve-release paths); Observability (settle/withdraw/payout latency + success, drift metric, dues aging); Tests green; Deployment (background indexes, flag-gated mirror removal, rollback).

## 23-26. Files

- Create: domain/settlement.guards.js, validators, repos, reconciler job, tests.
- Modify: schemas (indexes + active-withdrawal unique), settlement/withdrawal/engine (conditional + session threading), finance reads (ledger-only), routes (deprecate legacy subset).
- Merge: legacy technician.js wallet subset INTO technicianWalletRoutes (keep paths one release).
- Delete: Profile mirror writes/columns (P9); legacy subset (post-migration).

## 27. Risks / Open Questions

Mirror-removal needs mobile/admin-dashboard field audit (any client reading balances gets same shape from read-model — verify). Floor/threshold ownership (centralize in GlobalSetting? confirm). Cross-module: M2 (KYC/bank/profile), M6 (complete hook + cancel penalty debit), M8 (paid/success contract — frozen), M10 (clawback debits + reserve holds — joint), M11 (notify), M12 (finance reads + dues reports).

## 28. Final Acceptance Criteria

Settle exactly-once; withdrawal never overdraws; payout terminal-once; dual-approval enforced; drift==0 for 7d; no direct balance writes; indexes verified; tests green.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: drift measured + reconciler live before mirror-removal; settlement-guard + conditional-withdrawal + active-unique in one release with storm tests green. Must NOT break: M6 complete hook, M8 success contract, M10 clawback/hold writes, M2 KYC reads, M11 notify payloads.
