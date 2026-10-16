import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import GlobalSetting from "../Schemas/GlobalSetting.js";
import { toPaise } from "./money.js";

/**
 * 💸 PAYOUT CONFIG (thresholds, floors, cooldowns)
 *
 * The automatic payout EXECUTION was removed with the RazorpayX integration:
 * technician payouts are manual-NEFT-only (admin bank transfer + UTR
 * mark-paid). What remains here is the shared configuration layer used by
 * manual flows — per-technician payout settings, the maintenance floor
 * enforced at withdrawal request time, and the admin settings UI:
 *
 *   - getAutoPayoutConfig / setAutoPayoutConfig (global knobs)
 *   - computeAutoPayoutForTech (per-tech estimate shown in wallet UIs)
 *
 * No function in this module creates withdrawals, reserves balances, or
 * calls any provider.
 */

/* ── Defaults & env fallbacks ── */
export const DEFAULT_AUTO_PAYOUT_ENABLED = true;
export const DEFAULT_AUTO_PAYOUT_THRESHOLD_PAISE = 500000; // ₹5,000
export const DEFAULT_MINIMUM_MAINTENANCE_PAISE = 10000; // ₹100
export const MIN_AUTO_PAYOUT_PAISE = 10000; // ₹100 — never auto-pay below this

// Keys stored in GlobalSetting (singleton key-value store)
const KEY_ENABLED = "payout.autoEnabled";
const KEY_THRESHOLD = "payout.autoThresholdPaise";
const KEY_MAINTENANCE = "payout.minimumMaintenancePaise";
const KEY_CRON = "payout.autoPayoutCronExpression";
const KEY_MIN_WITHDRAWAL = "payout.minWithdrawalAmountPaise";
const KEY_COOLDOWN = "payout.withdrawalCooldownDays";
const KEY_DUAL_APPROVAL = "payout.dualApprovalThresholdPaise";

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const envRupeesToPaise = (name, fallbackPaise) => {
  const v = toMoney(process.env[name]);
  if (v == null || v < 0) return fallbackPaise;
  return toPaise(v * 100);
};

/**
 * Resolve the EFFECTIVE global auto-payout config.
 * Precedence: GlobalSetting (admin-tuned, live) → env → defaults.
 */
export const getAutoPayoutConfig = async () => {
  const [
    enabledDoc,
    thresholdDoc,
    maintenanceDoc,
    cronDoc,
    minWithdrawalDoc,
    cooldownDoc,
    dualApprovalDoc,
  ] = await Promise.all([
    GlobalSetting.findOne({ key: KEY_ENABLED }).lean(),
    GlobalSetting.findOne({ key: KEY_THRESHOLD }).lean(),
    GlobalSetting.findOne({ key: KEY_MAINTENANCE }).lean(),
    GlobalSetting.findOne({ key: KEY_CRON }).lean(),
    GlobalSetting.findOne({ key: KEY_MIN_WITHDRAWAL }).lean(),
    GlobalSetting.findOne({ key: KEY_COOLDOWN }).lean(),
    GlobalSetting.findOne({ key: KEY_DUAL_APPROVAL }).lean(),
  ]);

  const envEnabled = process.env.AUTO_PAYOUT_ENABLED;
  const autoPayoutEnabled =
    enabledDoc?.value !== undefined
      ? Boolean(enabledDoc.value)
      : envEnabled !== undefined
        ? envEnabled === "true"
        : DEFAULT_AUTO_PAYOUT_ENABLED;

  const autoPayoutThresholdPaise = toPaise(
    thresholdDoc?.value ??
      envRupeesToPaise("AUTO_PAYOUT_THRESHOLD", DEFAULT_AUTO_PAYOUT_THRESHOLD_PAISE)
  );
  const minimumMaintenancePaise = toPaise(
    maintenanceDoc?.value ??
      envRupeesToPaise("MINIMUM_MAINTENANCE_BALANCE", DEFAULT_MINIMUM_MAINTENANCE_PAISE)
  );

  const autoPayoutCronExpression =
    cronDoc?.value || process.env.AUTO_PAYOUT_CRON_EXPRESSION || "0 */6 * * *";

  const minWithdrawalAmountPaise = toPaise(
    minWithdrawalDoc?.value ??
      envRupeesToPaise("MIN_WITHDRAWAL_AMOUNT", 10000) // ₹100 fallback
  );

  const withdrawalCooldownDays = Number(
    cooldownDoc?.value ?? (toMoney(process.env.WITHDRAWAL_COOLDOWN_DAYS) ?? 0)
  );

  const dualApprovalThresholdPaise = toPaise(
    dualApprovalDoc?.value ??
      envRupeesToPaise("DUAL_APPROVAL_THRESHOLD_INR", 5000000) // ₹50,000 fallback
  );

  return {
    autoPayoutEnabled,
    autoPayoutThresholdPaise,
    minimumMaintenancePaise,
    autoPayoutCronExpression,
    minWithdrawalAmountPaise,
    withdrawalCooldownDays,
    dualApprovalThresholdPaise,
  };
};

/**
 * Persist global auto-payout config into GlobalSetting (live, no restart).
 * @param {{autoPayoutEnabled?: boolean, autoPayoutThresholdPaise?: number, minimumMaintenancePaise?: number, autoPayoutCronExpression?: string, minWithdrawalAmountPaise?: number, withdrawalCooldownDays?: number, dualApprovalThresholdPaise?: number}} updates
 * @param {{userId?: string, role?: string}} [actor] — admin who changed it
 */
export const setAutoPayoutConfig = async (updates = {}, actor = null) => {
  const entries = [
    [KEY_ENABLED, updates.autoPayoutEnabled],
    [KEY_THRESHOLD, updates.autoPayoutThresholdPaise],
    [KEY_MAINTENANCE, updates.minimumMaintenancePaise],
    [KEY_CRON, updates.autoPayoutCronExpression],
    [KEY_MIN_WITHDRAWAL, updates.minWithdrawalAmountPaise],
    [KEY_COOLDOWN, updates.withdrawalCooldownDays],
    [KEY_DUAL_APPROVAL, updates.dualApprovalThresholdPaise],
  ].filter(([, value]) => value !== undefined);

  for (const [key, value] of entries) {
    await GlobalSetting.findOneAndUpdate(
      { key },
      {
        $set: {
          value,
          updatedBy: actor?.userId || null,
          updatedByRole: actor?.role || null,
          lastUpdatedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );
  }

  return getAutoPayoutConfig();
};


/**
 * Resolve a technician's EFFECTIVE payout settings: per-tech override
 * ?? global config. Pure — easily testable.
 */
export const resolveTechPayoutSettings = (tech = {}, config = {}) => {
  const perTech = tech.payoutSettings || {};
  return {
    autoPayoutEnabled:
      perTech.autoPayoutEnabled ?? config.autoPayoutEnabled ?? DEFAULT_AUTO_PAYOUT_ENABLED,
    autoPayoutThresholdPaise: toPaise(
      perTech.autoPayoutThresholdPaise ?? config.autoPayoutThresholdPaise ?? DEFAULT_AUTO_PAYOUT_THRESHOLD_PAISE
    ),
    minimumMaintenancePaise: toPaise(
      perTech.minimumMaintenancePaise ?? config.minimumMaintenancePaise ?? DEFAULT_MINIMUM_MAINTENANCE_PAISE
    ),
    preferredPayoutMode: perTech.preferredPayoutMode || "UPI",
  };
};

/**
 * Pure decision function: is this technician eligible for an auto-payout
 * right now, and if so, how much?
 *
 * @param {{availableBalancePaise?: number, payoutSettings?: object}} tech
 * @param {object} config — global config from getAutoPayoutConfig()
 * @returns {{eligible: boolean, reason: string, amountPaise: number,
 *            remainingToThresholdPaise: number, settings: object}}
 */
export const computeAutoPayoutForTech = (tech = {}, config = {}) => {
  const settings = resolveTechPayoutSettings(tech, config);
  const balancePaise = toPaise(tech.availableBalancePaise ?? 0);

  if (!settings.autoPayoutEnabled) {
    return {
      eligible: false,
      reason: "auto_payout_disabled",
      amountPaise: 0,
      remainingToThresholdPaise: 0,
      settings,
    };
  }

  if (balancePaise < settings.autoPayoutThresholdPaise) {
    return {
      eligible: false,
      reason: "below_threshold",
      amountPaise: 0,
      remainingToThresholdPaise: settings.autoPayoutThresholdPaise - balancePaise,
      settings,
    };
  }

  // Keep the maintenance floor in the wallet, pay out the rest.
  const amountPaise = balancePaise - settings.minimumMaintenancePaise;
  if (amountPaise < MIN_AUTO_PAYOUT_PAISE) {
    return {
      eligible: false,
      reason: "below_minimum_payout",
      amountPaise: 0,
      remainingToThresholdPaise: 0,
      settings,
    };
  }

  return {
    eligible: true,
    reason: "threshold_exceeded",
    amountPaise,
    remainingToThresholdPaise: 0,
    settings,
  };
};

/* ── Automatic payout execution was removed with the RazorpayX integration.
   createAndProcessAutoPayout() and processAutoPayouts() are deleted:
   technician payouts are manual-NEFT-only. ── */
