import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import { writeAuditLog } from "./audit.js";

/**
 * 🏦 LEDGER UTILITY — idempotent, transaction-safe platform cash ledger writes.
 *
 * Every entry carries a unique idempotencyKey; replays are no-ops (11000 → ok).
 * Can run inside a caller's Mongo session (pass { session }) so ledger + wallet
 * + booking updates commit atomically.
 *
 * @param {object} opts
 * @param {string} opts.type            entry type (see PlatformLedgerEntry)
 * @param {"credit"|"debit"} opts.direction
 * @param {number} opts.amountPaise
 * @param {string} opts.idempotencyKey  REQUIRED, unique
 * @param {object} [opts.refs]          { bookingId, paymentId, withdrawalId, technicianId }
 * @param {string} [opts.providerReference]
 * @param {string} [opts.description]
 * @param {object} [opts.metadata]
 * @param {object} [opts.session]       Mongo session (transaction)
 * @param {string} [opts.status]        default "posted"
 * @returns {Promise<{created: boolean, entry: object|null}>}
 */
export const postLedgerEntry = async ({
  type,
  direction,
  amountPaise,
  idempotencyKey,
  refs = {},
  providerReference = null,
  description = null,
  metadata = null,
  session = null,
  status = "posted",
}) => {
  const entry = {
    type,
    direction,
    amountPaise: Math.round(Number(amountPaise) || 0),
    currency: "INR",
    bookingId: refs.bookingId || null,
    paymentId: refs.paymentId || null,
    withdrawalId: refs.withdrawalId || null,
    technicianId: refs.technicianId || null,
    providerReference,
    status,
    idempotencyKey,
    description,
    metadata,
  };

  const opts = session ? { session } : {};
  try {
    await PlatformLedgerEntry.create([entry], opts);
    return { created: true, entry };
  } catch (e) {
    if (e?.code === 11000) {
      const existing = await PlatformLedgerEntry.findOne({ idempotencyKey }, null, opts).lean();
      return { created: false, entry: existing };
    }
    throw e;
  }
};

/**
 * Post ledger entries for a verified customer payment (idempotent per key).
 * Creates: customer_payment (credit), technician_earning_liability (liability),
 * platform_commission (credit). GST liability entry is optional.
 *
 * @returns {Promise<{created: number, keys: string[]}>}
 */
export const postPaymentLedgerEntries = async ({
  payment,
  booking,
  session = null,
}) => {
  const refs = { bookingId: payment.bookingId, paymentId: payment._id };
  const keys = [
    `payment:${payment._id}:customer-payment`,
    `payment:${payment._id}:liability`,
    `payment:${payment._id}:commission`,
  ];

  let created = 0;
  const r1 = await postLedgerEntry({
    type: "customer_payment",
    direction: "credit",
    amountPaise: payment.totalAmountPaise,
    idempotencyKey: keys[0],
    refs,
    providerReference: payment.providerPaymentId || null,
    description: "Customer payment captured via Razorpay",
    session,
  });
  if (r1.created) created += 1;

  const r2 = await postLedgerEntry({
    type: "technician_earning_liability",
    direction: "debit",
    amountPaise: payment.technicianAmountPaise,
    idempotencyKey: keys[1],
    refs,
    providerReference: payment.providerPaymentId || null,
    description: "Technician earning liability allocated (not yet paid out)",
    session,
  });
  if (r2.created) created += 1;

  const r3 = await postLedgerEntry({
    type: "platform_commission",
    direction: "credit",
    amountPaise: payment.commissionAmountPaise,
    idempotencyKey: keys[2],
    refs,
    providerReference: payment.providerPaymentId || null,
    description: `Platform commission (${payment.commissionPercentage}%) from customer payment`,
    session,
  });
  if (r3.created) created += 1;

  return { created, keys };
};

/**
 * Post a technician-payout ledger entry once the RazorpayX payout is confirmed.
 * Idempotent: "payout:<withdrawalId>:technician-payout".
 */
export const postPayoutLedgerEntry = async ({
  withdrawal,
  providerReference,
  session = null,
}) => {
  const key = `payout:${withdrawal._id}:technician-payout`;
  return postLedgerEntry({
    type: "technician_payout",
    direction: "debit",
    amountPaise: withdrawal.amountPaise ?? Math.round((withdrawal.amount || 0) * 100),
    idempotencyKey: key,
    refs: { withdrawalId: withdrawal._id, technicianId: withdrawal.technicianId },
    providerReference,
    description: "RazorpayX payout to technician bank/UPI",
    session,
  });
};

/**
 * Convenience: write an AuditLog entry inside/outside a session.
 */
export const audit = async ({ action, actor, actorRole, targetType, targetId, before, after, reason, session, metadata }) => {
  return writeAuditLog({
    action,
    actor,
    actorRole,
    targetType,
    targetId,
    before,
    after,
    reason,
    metadata,
    session,
  });
};