# RightTouch — Module Audit Index

> 12 production-level rewrite audits. Each document is self-contained and follows the same 28-section template (Executive Summary → … → Acceptance Criteria → "Can this module safely be rewritten now?").
> Status for ALL modules: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

| # | Module | Document | Rewrite verdict |
|---|--------|----------|-----------------|
| 1 | M1 — Auth & Identity | [M1-Auth-Identity-Audit.md](./M1-Auth-Identity-Audit.md) | YES WITH CONDITIONS |
| 2 | M2 — Technician | [M2-Technician-Audit.md](./M2-Technician-Audit.md) | YES WITH CONDITIONS |
| 3 | M3 — Geo / Zones | [M3-Geo-Zones-Audit.md](./M3-Geo-Zones-Audit.md) | YES WITH CONDITIONS |
| 4 | M4 — Catalog | [M4-Catalog-Audit.md](./M4-Catalog-Audit.md) | YES |
| 5 | M5 — Cart & Address | [M5-Cart-Address-Audit.md](./M5-Cart-Address-Audit.md) | YES |
| 6 | M6 — Service Booking & Dispatch | [M6-Service-Booking-Dispatch-Audit.md](./M6-Service-Booking-Dispatch-Audit.md) | YES WITH CONDITIONS |
| 7 | M7 — Product & Quotation | [M7-Product-Quotation-Audit.md](./M7-Product-Quotation-Audit.md) | YES WITH CONDITIONS |
| 8 | M8 — Payments | [M8-Payments-Audit.md](./M8-Payments-Audit.md) | YES WITH CONDITIONS |
| 9 | M9 — Wallet / Settlement / Payout | [M9-Wallet-Settlement-Payout-Audit.md](./M9-Wallet-Settlement-Payout-Audit.md) | YES WITH CONDITIONS |
| 10 | M10 — Refund / Complaint-hold | [M10-Refund-Complaint-Audit.md](./M10-Refund-Complaint-Audit.md) | YES WITH CONDITIONS |
| 11 | M11 — Notifications | [M11-Notifications-Audit.md](./M11-Notifications-Audit.md) | YES WITH CONDITIONS |
| 12 | M12 — Support / System | [M12-Support-System-Audit.md](./M12-Support-System-Audit.md) | YES |

## Suggested rewrite order (low-risk first)

```text
M4 (Catalog) + M12 (Support/System, no money) + M5 (Cart/Address)
 → M1 (Auth gates) → M3 (Geo console) → M2 (Technician)
 → M6 (Booking core) + M7 (Quote/Product)
 → M8 (Payments) → M9 (Settlement/Payout) → M10 (Refund)
 → M11 (Notifications infra: token cutover + Redis presence before scale-out)
```

Joint-delivery bundles (must ship together): {M6+M7 accept/convert}, {M6+M10 paid-cancel}, {M7+M8 converted hook}, {M7+M10 paid-cancel}, {M8+M9 success contract}, {M8+M10 reservation}, {M9+M10 clawback/dues}, {M10+M12 refund trigger}, {M1+M11 token cutover}, {M2+M3 permission/mapping}, {M6+M11 revoke}.

## Cross-cutting invariants (every module)

1. Single transition gate per aggregate; no direct `status=` writes (grep-enforced).
2. Money in paise; snapshots immutable; ledger append-only.
3. Atomic/conditional DB ops before Redis/distributed locks.
4. Outbox + lease + retry + dead-letter for every external effect.
5. Idempotency keys with unique backstops on every repeatable op.
6. `Auth + requireRole` on every route; IDOR matrix tested.
7. Request IDs, structured logs, per-module metrics, audit on money/status/admin acts.

## Related docs

- `../BACKEND_MODULES_RESPONSIBILITIES.md` — what every module owns (files, routes, flows).
- `../BACKEND_REWRITE_ANALYSIS.md` — earlier wrong-flow notes per module.
