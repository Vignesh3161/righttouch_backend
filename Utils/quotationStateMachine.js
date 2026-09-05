/**
 * Quotation state machines (Remediation architecture §8).
 *
 * Centralizes legal transitions so controllers/services never hard-code ad-hoc
 * status jumps. A transition that isn't listed here is rejected.
 */

export const QUOTE_REQUEST_STATES = [
  "quote_requested",
  "under_review",
  "quotation_prepared",
  "quotation_sent",
  "viewed",
  "accepted",
  "rejected",
  "cancelled",
  "expired",
];

export const QUOTATION_STATES = [
  "draft",
  "sent",
  "viewed",
  "accepted",
  "rejected",
  "expired",
  "superseded",
  "converted",
];

const QUOTE_REQUEST_TRANSITIONS = {
  quote_requested: ["under_review", "quotation_prepared", "quotation_sent", "quoted", "cancelled"],
  under_review: ["quotation_prepared", "quotation_sent", "quoted", "cancelled"],
  quotation_prepared: ["under_review", "quotation_sent", "quoted", "cancelled"],
  quotation_sent: ["viewed", "accepted", "rejected", "declined", "cancelled", "expired", "under_review", "quotation_prepared"],
  viewed: ["quotation_sent", "accepted", "rejected", "declined", "cancelled", "expired", "under_review", "quotation_prepared"],
  accepted: ["expired"], // terminal-ish; conversion is tracked on the Quotation
  rejected: ["under_review", "quote_requested", "quotation_prepared", "quotation_sent"],
  declined: ["under_review", "quote_requested", "quotation_prepared", "quotation_sent"],
  cancelled: [],
  expired: ["under_review", "quote_requested", "quotation_prepared", "quotation_sent"],
};

const QUOTATION_TRANSITIONS = {
  draft: ["sent", "superseded"],
  sent: ["viewed", "accepted", "rejected", "expired", "superseded"],
  viewed: ["accepted", "rejected", "expired", "superseded"],
  accepted: ["converted"],
  rejected: [],
  expired: [],
  superseded: [],
  converted: [],
};

export const canTransitionQuoteRequest = (from, to) =>
  from === to || Boolean(QUOTE_REQUEST_TRANSITIONS[from]?.includes(to));

export const canTransitionQuotation = (from, to) =>
  from === to || Boolean(QUOTATION_TRANSITIONS[from]?.includes(to));

export const assertQuoteRequestTransition = (from, to) => {
  if (typeof to !== "string" || !QUOTE_REQUEST_STATES.includes(to)) {
    const err = new Error(
      `Invalid quote request status '${to}'. Status must be one of: ${QUOTE_REQUEST_STATES.join(", ")}.`
    );
    err.statusCode = 400;
    throw err;
  }
  if (!canTransitionQuoteRequest(from, to)) {
    const allowed = QUOTE_REQUEST_TRANSITIONS[from] || [];
    const err = new Error(
      `Illegal quote request transition: '${from}' → '${to}'. ` +
        `Allowed next states from '${from}': ${
          allowed.length ? allowed.join(", ") : "(none — this state is terminal)"
        }.`
    );
    err.statusCode = 409;
    throw err;
  }
};

export const assertQuotationTransition = (from, to) => {
  if (typeof to !== "string" || !QUOTATION_STATES.includes(to)) {
    const err = new Error(
      `Invalid quotation status '${to}'. Status must be one of: ${QUOTATION_STATES.join(", ")}.`
    );
    err.statusCode = 400;
    throw err;
  }
  if (!canTransitionQuotation(from, to)) {
    const allowed = QUOTATION_TRANSITIONS[from] || [];
    const err = new Error(
      `Illegal quotation transition: '${from}' → '${to}'. ` +
        `Allowed next states from '${from}': ${
          allowed.length ? allowed.join(", ") : "(none — this state is terminal)"
        }.`
    );
    err.statusCode = 409;
    throw err;
  }
};

/** Active (mutable) quotation states — a request may have at most one. */
export const ACTIVE_QUOTATION_STATES = ["sent", "viewed"];
