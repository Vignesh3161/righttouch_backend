# Manual Payouts (Admin & Technician)

This document describes the current manual payout system: configuration, end-to-end
flows, endpoints, notifications, socket events, and the Postman collection.

Automatic payout execution is permanently disabled
(`AUTO_PAYOUT_EXECUTION_ENABLED = false` in `Utils/autoPayout.js`). All new money
movements are initiated or released by an Admin/Owner after an offline bank/UPI
transfer.

## Roles and permissions

| Role | Payout capabilities |
| --- | --- |
| Technician | Read own wallet/limits, request withdrawal, cancel before approval, read own history/receipt, update maintenance/preferred payout mode |
| Admin | Read wallet/settings, review/approve/reject requests, record UTR as paid, send manual payouts, freeze/unfreeze, read audited bank details |
| Owner | Same as Admin, plus revert a wrongly-recorded paid withdrawal |
| Customer | No payout access |

`revert-paid` is Owner-only. `send-money` and approval endpoints accept Admin or
Owner, but the second approver must be a different admin user.

## Global configuration

All limits resolve in this order:

1. `GlobalSetting` key (live admin setting)
2. Environment variable
3. Hard-coded default

| GlobalSetting key | Env fallback | Default | Used by |
| --- | --- | --- | --- |
| `payout.minWithdrawalAmountPaise` | `MIN_WITHDRAWAL_AMOUNT` (rupees) | ₹100 | Technician request and admin direct |
| `payout.maxWithdrawalAmountPaise` | `MAX_WITHDRAWAL_AMOUNT` (rupees) | ₹50,000 | Technician request and admin direct |
| `payout.withdrawalCooldownDays` | `WITHDRAWAL_COOLDOWN_DAYS` | `0` | Technician request only |
| `payout.minimumMaintenancePaise` | `MINIMUM_MAINTENANCE_BALANCE` (rupees) | ₹100 | Available-to-withdraw calculation |
| `payout.dualApprovalThresholdPaise` | `DUAL_APPROVAL_THRESHOLD_INR` (rupees) | ₹10,000 | Admin direct payout second approval |
| `payout.adminManualDualApprovalPaise` | — | — | Legacy fallback only |

Deprecated auto-payout settings remain readable/writable for compatibility but do
not enable execution:

- `payout.autoEnabled`
- `payout.autoThresholdPaise`
- `payout.autoPayoutCronExpression`

Settings API responses include:

- `autoPayoutExecutionEnabled: false`
- `deprecatedAutoPayoutFields: [...]`
- `maxWithdrawalAmount` / `maxWithdrawalAmountPaise`
- `minWithdrawalAmount` / `minWithdrawalAmountPaise`
- `withdrawalCooldownDays`
- `dualApprovalThreshold` / `dualApprovalThresholdPaise`

The settings update endpoint rejects:

- `maxWithdrawalAmount < ₹100`
- `maxWithdrawalAmount < minWithdrawalAmount`
- `minWithdrawalAmount > maxWithdrawalAmount`
- negative maintenance/cooldown/dual-approval values

## Flow 1 — Technician-initiated withdrawal

```text
Technician                Server                         Admin
    |                        |                             |
    | POST /wallet/withdrawal|                             |
    |----------------------->| validate limits/KYC/dues    |
    |                        | reserve available -> reserved|
    |                        | create requested            |
    |                        | emit withdrawal:requested  |
    |                        |---------------------------->|
    |                        |                             | GET /wallet/withdrawals
    |                        |                             | GET /withdrawal/:id/details
    |                        |                             | PUT /withdrawal/:id/approve
    |                        |<----------------------------|
    |                        | status = approved           |
    |                        |                             | offline bank/UPI transfer
    |                        |                             | POST /withdrawal/:id/mark-paid + UTR
    |                        |<----------------------------|
    |                        | approved -> paid            |
    |                        | release reserve             |
    |                        | write technician_payout     |
    |                        | emit auto_payout_paid      |
    |<-----------------------| notification + push         |
```

### Request-time guards

- Amount above zero, above global minimum, below global maximum.
- Technician not blocked/suspended.
- KYC bank verification approved.
- Bank/UPI fingerprint matches the verified KYC record.
- Available balance minus maintenance floor is sufficient.
- No outstanding dues.
- No active complaint/payout block.
- No other payout in `pending`, `requested`, `approved`, `processing`, or
  `manual_review`.
- Withdrawal cooldown (last `paid`/`approved` technician request).
- Optional `clientIdempotencyKey` replay returns the existing request.

The balance is reserved at request time; admin approval does not move money.
`mark-paid` transitions `approved -> paid`, releases the reserve, and records the
ledger entry.

### Reject and cancel

- Admin reject: `pending/requested/approved -> rejected`; reserved balance is
  refunded.
- Technician cancel: own `pending/requested` request only; reserved balance is
  refunded.
- `processing` and `manual_review` cannot be cancelled by the technician.

## Flow 2 — Admin direct payout

`POST /api/admin/wallet/technician/:technicianId/send-money`

The same request-time guards apply. The payout origin is `admin_direct`.

| Amount | Result |
| --- | --- |
| Below `dualApprovalThresholdPaise` | Created as `approved`; admin transfers offline and marks paid |
| At/above `dualApprovalThresholdPaise` | Created as `requested` with `requiresApproval: true`; a different admin must call `approve-manual-payout` |

`approve-manual-payout`:

- Requires `origin=admin_direct` and `requiresApproval=true`.
- Requires current status `requested`.
- Rejects the initiating admin as approver.
- Compare-and-set transitions `requested -> approved`.

## Flow 3 — Corrections and holds

| Action | Endpoint | Effect |
| --- | --- | --- |
| Revert paid | `POST /wallet/withdrawal/:id/revert-paid` (Owner) | `paid -> failed`; restores gross amount; writes compensating ledger entry; original ledger row is not edited |
| Resolve manual review | `PUT /wallet/withdrawal/:id/resolve-manual-review` | Legacy: `complete` forces paid; `revert` refunds reserve |
| Freeze payouts | `PUT /wallet/technician/:technicianId/freeze` | Blocks new payout requests; reason required when freezing |
| Unfreeze payouts | Same endpoint with `freeze:false` | Clears the block |

## Status and origin

### Origin

- `technician_request` — technician submitted a withdrawal request.
- `admin_direct` — admin initiated Send Money.
- `auto` — legacy automatic records only; no new records are created.

### Status

- `requested` — awaiting admin review, or awaiting second-admin approval for
  high-value `admin_direct`.
- `approved` — ready for offline transfer.
- `paid` — UTR recorded; reserve released; ledger debited.
- `rejected` — admin rejected; reserve refunded.
- `processing` / `manual_review` — legacy intermediate states.
- `failed` — reverted paid record.

## Money and ledger invariants

- All persisted amounts are integer paise.
- Request time: `availableBalancePaise` decreases, `reservedBalancePaise`
  increases.
- Approve time: no balance movement; status changes only.
- Mark-paid: reserve is released; lifetime withdrawn increases; a
  `technician_payout` debit ledger entry is written with idempotency key
  `payout:<withdrawalId>:technician-payout`.
- Revert-paid: gross amount is restored; a compensating
  `technician_payout_reversal` entry is written.
- UTR is unique across withdrawals; duplicate mark-paid with the same UTR is
  idempotent.
- A unique partial index allows only one active payout per technician.

## Endpoint reference

### Technician

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/technician/wallet` | Balances, payout destination, effective limits |
| GET | `/api/technician/wallet/transactions` | Wallet credits/debits |
| POST | `/api/technician/wallet/withdrawal` | Request withdrawal (`amountPaise` preferred) |
| POST | `/api/technician/wallet/withdrawal/:id/cancel` | Cancel own pending/requested request |
| GET | `/api/technician/wallet/withdrawalhistory` | Own payout history |
| GET | `/api/technician/wallet/withdrawal/:id/receipt` | Receipt after `paid` |
| PUT | `/api/technician/wallet/payout-settings` | Maintenance floor / preferred mode (auto fields deprecated) |
| GET | `/api/technician/finance/earnings` | Earnings summary |

### Admin/Owner

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/wallet` | Wallet summary and payout counters |
| GET | `/api/admin/settings/auto-payout` | Effective payout configuration |
| PUT | `/api/admin/settings/auto-payout` | Update min/max/cooldown/dual-approval |
| GET | `/api/admin/wallet/auto-payouts/summary` | Deprecated legacy auto statistics |
| GET | `/api/admin/wallet/withdrawals` | Paginated payout queue |
| GET | `/api/admin/wallet/withdrawal/:id/details` | Audited decrypted bank details |
| GET | `/api/admin/wallet/withdrawal/:id/receipt` | Paid payout receipt |
| PUT | `/api/admin/wallet/withdrawal/:id/approve` | Approve request |
| PUT | `/api/admin/wallet/withdrawal/:id/reject` | Reject and refund reserve |
| POST | `/api/admin/wallet/withdrawal/:id/mark-paid` | Record UTR and complete payout |
| POST | `/api/admin/wallet/withdrawal/:id/revert-paid` | Owner-only correction |
| POST | `/api/admin/wallet/technician/:technicianId/send-money` | Admin direct payout |
| PUT | `/api/admin/wallet/withdrawal/:id/approve-manual-payout` | Second-admin approval |
| PUT | `/api/admin/wallet/withdrawal/:id/resolve-manual-review` | Legacy manual-review resolution |
| PUT | `/api/admin/wallet/technician/:technicianId/freeze` | Freeze/unfreeze payouts |
| GET | `/api/admin/wallet/technician/:technicianId` | Technician wallet overview |
| GET | `/api/admin/wallet/export` | CSV export |
| GET | `/api/admin/wallet/bulk-payment-export` | Bulk bank-run export (masked account) |

## Socket events and notifications

### Current behavior

| Role | Socket event | When | Persistent notification | Push |
| --- | --- | --- | --- | --- |
| Admin | `withdrawal:requested` (room `admin_dashboard`) | Technician submits a request | None currently | None |
| Technician | `auto_payout_paid` (room `technician_<profileId>`) | Admin marks a payout paid | `WITHDRAWAL_PAID` row | Yes |
| Technician | — | Admin rejects a request | `WITHDRAWAL_REJECTED` row | No |
| Technician | — | Owner reverts a paid payout | `WITHDRAWAL_FAILED` row | No |
| Technician | — | Admin freezes/unfreezes payouts | None | None |
| Customer | — | Payouts do not involve customers | None | None |

`notification:new` is only emitted automatically by the unified notification
service. The current payout code uses direct `Notification.create()` calls for
reject/revert and a manual socket emit for paid, so `notification:new` is not
guaranteed for all payout events.

### Recommended event contract

The following additions would make payout real-time behavior consistent. They are
documented here but not implemented by the current collection work.

| Event | Recipient | Payload |
| --- | --- | --- |
| `withdrawal:requested` | Admin dashboard | `withdrawalId`, `technicianId`, amount, status |
| `withdrawal:approval_required` | Admin dashboard | `withdrawalId`, amount, dual-approval threshold |
| `withdrawal:approved` | Technician | `withdrawalId`, `netPayoutAmountPaise`, status |
| `withdrawal:rejected` | Technician | `withdrawalId`, reason, refunded amount |
| `withdrawal:paid` | Technician | `withdrawalId`, UTR, net amount, payout mode |
| `withdrawal:failed` | Technician + Admin | `withdrawalId`, reason, restored amount |
| `payout:frozen` | Technician | `technicianId`, reason |
| `payout:unfrozen` | Technician | `technicianId` |
| `notification:new` | All roles | Standard notification tray payload |

Recommended notification event types/templates:

- `WITHDRAWAL_REQUESTED` (admin)
- `WITHDRAWAL_APPROVAL_REQUIRED` (admin)
- `WITHDRAWAL_APPROVED` (technician)
- `WITHDRAWAL_REJECTED` (technician)
- `WITHDRAWAL_PAID` (technician)
- `WITHDRAWAL_FAILED` (technician, existing template)
- `PAYOUT_FROZEN` / `PAYOUT_UNFROZEN` (technician)

If these are implemented later, route them through
`Services/unifiedNotificationService.js` or `Services/notificationService.js` so
persistent row, `notification:new`, specific socket event, and push stay aligned.

## Postman collection

Collection:
`postman/postmancollection/collections/righttouch_manual_payouts.postman_collection.json`

Environment:
`postman/postmancollection/environments/righttouch_manual_payouts.postman_environment.json`

### Folder order

1. `00 - Setup & Auth`
2. `01 - Payout Configuration`
3. `02 - Technician Withdrawal`
4. `03 - Admin Review & Release`
5. `04 - Admin Direct & Dual Approval`
6. `05 - Notifications`
7. `06 - Socket.IO Probe`
8. `07 - Guard Cases`

Run folders in order. Folder 00 captures tokens and `technicianId`. Folder 02
captures `withdrawalId`. Folder 03 captures it again from the queue and details.

### Important environment values

| Variable | Purpose |
| --- | --- |
| `technicianMobile` / `technicianLoginOtp` | Technician OTP login |
| `adminMobile` / `adminPassword` / `adminRole` | Initiating admin login |
| `secondAdminMobile` / `secondAdminPassword` | Different admin for dual approval |
| `ownerMobile` / `ownerPassword` | Owner-only revert |
| `technicianId` | Admin direct/freeze/overview requests |
| `withdrawalId` | Approve/reject/mark-paid/receipt/revert |
| `utr` | 8-30 uppercase alphanumeric UTR; use a unique value per run |
| `requestAmountPaise` | Normal payout amount (default ₹500) |
| `dualPayoutAmountPaise` | High-value amount for dual-approval testing (default ₹15,000) |

### Canonical collection cleanup

The focused collection is the recommended payout runbook. The existing canonical
collections were also updated:

- Admin: removed the duplicate `List Withdrawal History (alias)` request; updated
  the settings GET/PUT examples and assertions; marked auto summary deprecated;
  documented that list responses exclude bank data.
- Technician: removed duplicate payout aliases
  (`/wallet/withdrawalhistory/me`, `/wallet/withdrawal/request`, `PUT cancel`) and
  the Owner-only `POST /wallet/transaction` request; updated wallet/withdrawal
  examples and deprecation notes.

### Notes

- `06 - Socket.IO Probe` only verifies the Engine.IO handshake. Postman cannot
  authenticate or subscribe to Socket.IO events; use a Socket.IO client with
  `auth.token`.
- `07 - Guard Cases` contains expected 4xx requests. Run it only after the main
  flow or when preparing negative tests.
- `Revert Paid Withdrawal` is destructive and requires an Owner token.
- The default UTR is a sample; reusing it on another payout returns 409.

## Verification checklist

- `GET /api/admin/settings/auto-payout` returns `maxWithdrawalAmountPaise` and
  `autoPayoutExecutionEnabled:false`.
- `PUT /api/admin/settings/auto-payout` rejects `max < min`.
- `GET /api/technician/wallet` returns `payoutLimits.maxWithdrawalPaise` and the
  KYC-backed masked destination.
- A technician request creates status `requested`, reserves balance, and emits
  `withdrawal:requested`.
- `PUT /approve` returns `approved`; `POST /mark-paid` returns `paid`.
- `GET /withdrawal/:id/details` includes decrypted bank data and writes an audit
  log.
- Duplicate UTR returns 409 unless the same UTR is already recorded on the same
  withdrawal.
- Revert restores the gross amount and creates a compensating ledger entry.
- Auto summary responses include `deprecated:true` and `manualOnly:true`.
