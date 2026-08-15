/**
 * 💰 MONEY UTILITIES — integer-paise financial math.
 *
 * ALL persisted financial amounts are integer PAISE (1 ₹ = 100 paise).
 * Floating-point arithmetic is NEVER persisted. Razorpay/RazorpayX use
 * integer paise natively, so no precision is lost across the wire.
 */

export const toPaise = (v) => {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
};

export const rupeesToPaise = (rupees) => {
  if (rupees == null || rupees === "") return 0;
  const n = Number(rupees);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};

export const paiseToRupees = (paise) => {
  const p = toPaise(paise);
  return p / 100;
};

/**
 * percentageOf — integer-paise safe percentage (banker's-style round-half-up,
 * identical to Razorpay's own paise rounding).
 */
export const percentageOf = (amountPaise, percent) => {
  const amt = toPaise(amountPaise);
  const pct = Number(percent);
  if (!Number.isFinite(pct)) return 0;
  if (amt <= 0 || pct <= 0) return 0;
  return Math.round((amt * pct) / 100);
};

export const add = (...values) => values.reduce((s, v) => s + toPaise(v), 0);

export const sub = (a, b) => toPaise(a) - toPaise(b);

/**
 * splitWithCommission — the ONLY commission math in the system.
 *
 *   commissionAmountPaise  = round(totalAmountPaise × commissionPercentage / 100)
 *   technicianAmountPaise  = totalAmountPaise − commissionAmountPaise
 *
 * Invariants enforced:
 *   0 <= commissionPercentage <= ceiling
 *   0 <= commissionAmountPaise <= totalAmountPaise
 *   technicianAmountPaise >= 0
 *   commissionAmountPaise + technicianAmountPaise === totalAmountPaise
 *
 * @returns {{ok: boolean, commissionAmountPaise: number, technicianAmountPaise: number, error?: string}}
 */
export const splitWithCommission = (totalAmountPaise, commissionPercentage, ceiling = 60) => {
  const total = toPaise(totalAmountPaise);
  const pct = Number(commissionPercentage);
  const cap = Number(ceiling) > 0 && Number(ceiling) <= 100 ? Number(ceiling) : 60;

  if (total < 0) return { ok: false, commissionAmountPaise: 0, technicianAmountPaise: 0, error: "negative_total" };
  if (!Number.isFinite(pct) || pct < 0) return { ok: false, commissionAmountPaise: 0, technicianAmountPaise: 0, error: "invalid_percentage" };
  if (pct > cap) return { ok: false, commissionAmountPaise: 0, technicianAmountPaise: 0, error: "percentage_above_ceiling" };

  const commissionAmountPaise = Math.min(percentageOf(total, pct), total);
  const technicianAmountPaise = total - commissionAmountPaise;

  if (commissionAmountPaise + technicianAmountPaise !== total) {
    return { ok: false, commissionAmountPaise: 0, technicianAmountPaise: 0, error: "split_invariant_broken" };
  }
  return { ok: true, commissionAmountPaise, technicianAmountPaise };
};

/** Assert a money object satisfies the additive invariant. Throws otherwise. */
export const assertSplit = ({ totalAmountPaise, commissionAmountPaise, technicianAmountPaise }) => {
  const total = toPaise(totalAmountPaise);
  const c = toPaise(commissionAmountPaise);
  const t = toPaise(technicianAmountPaise);
  if (c < 0 || t < 0) throw new Error(`negative split component (commission=${c}, technician=${t})`);
  if (c + t !== total) {
    throw new Error(
      `split invariant violated: commission(${c}) + technician(${t}) !== total(${total})`
    );
  }
  return true;
};

export const CALCULATION_VERSION = 2;

export const zeroSnapshot = () => ({
  baseAmountPaise: 0,
  discountAmountPaise: 0,
  totalAmountPaise: 0,
  commissionPercentage: 0,
  commissionAmountPaise: 0,
  technicianAmountPaise: 0,
  commissionRuleSource: "none",
  commissionRuleId: null,
  calculationVersion: CALCULATION_VERSION,
  commissionOverridden: false,
  financialSnapshotAt: null,
});
