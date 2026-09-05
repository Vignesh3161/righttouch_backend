import GlobalSetting from "../Schemas/GlobalSetting.js";

export const REFUND_CLASS_A_REASONS = [
  "technician_cancelled",
  "system_cancelled",
  "no_technician_assigned",
  "service_not_rendered",
  "duplicate_payment",
  "overcharge",
  "chargeback_conceded",
];

export const REFUND_CLASS_B_REASONS = [
  "quality_dispute",
  "damage",
  "incomplete_work",
  "technician_misconduct",
  "goodwill",
];

const DEFAULTS = {
  MDR_PCT: 2.36,
  GST_ON_FEE_PCT: 18,
  REFUND_DUAL_APPROVAL_ABOVE_PAISE: 500000,
  COMPLAINT_WINDOW_HOURS: 72,
  REFUND_WINDOW_DAYS: 30,
  REFUND_HARD_LIMIT_DAYS: 180,
  COMPLAINT_HOLD_MAX_HOURS: 72,
  REFUND_STALE_HOURS: 48,
  MAX_REFUND_ATTEMPTS: 3,
  HIGH_VALUE_THRESHOLD_PAISE: 1000000,
  HIGH_DISPUTE_RETENTION_BONUS_PCT: 10,
  REFUND_RATE_RETENTION_BONUS_PCT: 15,
  MAX_RECOVERY_PCT_PER_JOB: 50,
  CUSTOMER_BANK_COOLOFF_HOURS: 24,
  MAX_CUSTOMER_PAYOUT_REFUND_PAISE: 5000000,
  CLASS_A_SLA_MS: 60000,
  INSTANT_REFUND_FEE_PAISE: 0,
};

const KEY = "refund.policy";

const toNum = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};

export const getRefundPolicy = async () => {
  const doc = await GlobalSetting.findOne({ key: KEY }).lean();
  const stored = doc?.value && typeof doc.value === "object" ? doc.value : {};
  return { ...DEFAULTS, ...stored };
};

export const setRefundPolicy = async (updates = {}) => {
  const doc = await GlobalSetting.findOneAndUpdate(
    { key: KEY },
    { $set: { value: { ...DEFAULTS, ...updates }, updatedAt: new Date() } },
    { upsert: true, new: true }
  ).lean();
  return doc?.value || { ...DEFAULTS, ...updates };
};

export const isClassA = (reason) => REFUND_CLASS_A_REASONS.includes(reason);
export const isClassB = (reason) => REFUND_CLASS_B_REASONS.includes(reason);

export const defaultFaultParty = (reason) => {
  if (reason === "duplicate_payment" || reason === "overcharge") return "technician";
  return "platform";
};

export const computeMdrLossPaise = (refundGrossPaise, policy) => {
  const fee = (refundGrossPaise * (policy.MDR_PCT || 0)) / 100;
  const withTax = fee * (1 + (policy.GST_ON_FEE_PCT || 0) / 100);
  return Math.round(withTax);
};

export const computeGstDeadline = (supplyDate) => {
  const d = supplyDate ? new Date(supplyDate) : new Date();
  const calYear = d.getFullYear();
  const fyEndYear = d.getMonth() >= 3 ? calYear + 1 : calYear;
  return new Date(fyEndYear, 10, 30, 23, 59, 59);
};

export const isGstRecoverable = (supplyDate, now = new Date()) =>
  now <= computeGstDeadline(supplyDate);

export const withinComplaintWindow = (completedAt, policy, now = new Date()) => {
  if (!completedAt) return false;
  const ms = (now - new Date(completedAt)) / 36e5;
  return ms <= policy.COMPLAINT_WINDOW_HOURS;
};
