/**
 * 📋 HISTORICAL WITHDRAWAL REVIEW GUIDE (read-only data)
 *
 * Actionable operator matrix for `processing` / `manual_review` / `failed`
 * withdrawals (including legacy provider-linked records from the removed
 * automated payout integration). This module contains NO database access
 * and performs NO mutations — it maps a withdrawal status to the evidence
 * an authorized human must gather and the actions that are safe, so
 * historical records are never auto-marked paid or failed and reserves are
 * never released without verified evidence.
 *
 * Technician payouts are manual-NEFT-only: there is no provider webhook.
 * Evidence comes from the bank portal / bank statement and the linked
 * PayoutOutbox row (historical), resolved only via the audited
 * resolve-manual-review endpoint.
 *
 * Double-action safety (enforced by the handlers, asserted in tests):
 * - complete-twice: `completePayout` returns early on `paid` (single ledger).
 * - revert-twice: `adminResolveManualReview` rejects non-`manual_review`
 *   (second call throws; reserve released once, single refund row).
 * - revert-paid twice: Owner-only endpoint is idempotent on
 *   (failed + revertedBy).
 * - mark-paid twice: same-UTR idempotent; different-UTR 409.
 */

export const REVIEWABLE_STATUSES = ["processing", "manual_review", "failed"];

const NEVER = [
  "mark the record paid/failed/cancelled without verified evidence",
  "assume a provider timeout or missing outbox row means the transfer failed",
  "retry a provider transfer while manual-only mode is active",
  "release a reserve or write a reversal outside the audited endpoints",
];

export const WITHDRAWAL_REVIEW_GUIDE = {
  processing: {
    meaning: "A legacy provider transfer was initiated (or a legacy record claims so) and no terminal event was reconciled. No new provider transfers can exist — the integration was removed.",
    evidenceRequired: [
      "linked PayoutOutbox row (withdrawalId match) with razorpayPayoutId, if any",
      "bank portal / bank statement status for that payout (processed / failed / absent)",
      "bank statement / UTR when a transfer is claimed successful",
      "held reserve amount vs withdrawal gross",
    ],
    allowedActions: [
      "resolve-manual-review {complete} with the verified bank evidence attached",
      "resolve-manual-review {revert} only after failure/absence is confirmed",
    ],
    forbiddenActions: [...NEVER, "mark-paid while status is processing (endpoint requires approved)"],
  },
  manual_review: {
    meaning: "Ambiguous legacy outcome. Nothing is known about the money.",
    evidenceRequired: [
      "bank portal search by amount/date/technician destination",
      "bank statement for the reserve amount",
      "outbox attempts/lastError history",
    ],
    allowedActions: [
      "resolve-manual-review {complete} only with verified provider/bank evidence",
      "resolve-manual-review {revert} only after failure/absence is confirmed",
    ],
    forbiddenActions: [...NEVER],
  },
  failed: {
    meaning: "Terminal failure recorded; the held reserve was released exactly once (clamped) with a single compensating refund row.",
    evidenceRequired: [
      "failureReason/decisionNote on the record",
      "exactly one withdrawal-refund transaction for the withdrawal",
      "reservedBalancePaise movement consistent with the release",
    ],
    allowedActions: [
      "re-verify via the audit (failed records stay failed; re-request is a new withdrawal)",
      "escalate to engineering if the reserve does not reconcile",
    ],
    forbiddenActions: [...NEVER, "retry the transfer while manual-only mode is active", "mark-paid on a failed record (endpoint requires approved)"],
  },
};

/**
 * @param {string} status withdrawal status
 * @returns {object|null} guidance entry, or null for non-reviewable statuses
 */
export const getWithdrawalReviewGuidance = (status) =>
  WITHDRAWAL_REVIEW_GUIDE[status] || null;
