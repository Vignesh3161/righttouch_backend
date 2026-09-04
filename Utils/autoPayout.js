import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import GlobalSetting from "../Schemas/GlobalSetting.js";
import { writeAuditLog } from "./audit.js";
import { toPaise, paiseToRupees } from "./money.js";
import { executeWithdrawalPayout } from "./withdrawalPayoutEngine.js";
import { hasActivePayoutBlock } from "./complaintFreeze.js";
import { safeDebitAvailable } from "./walletDebit.js";
import { getIo } from "./ioAccess.js";

/**
 * 💸 AUTO-PAYOUT ENGINE
 *
 * Trigger: a technician's availableBalancePaise crosses the auto-payout
 * threshold (global config, per-tech overridable). The cron pays out
 * `balance − minimumMaintenancePaise` — keeping the maintenance floor in the
 * wallet — fully automatically:
 *
 *   1. processAutoPayouts() (cron, every 6 h) scans high-balance techs
 *   2. createAndProcessAutoPayout() [txn] creates a pre-approved
 *      WithdrawalRequest (type: "auto", autoApproved: true), reserves the
 *      balance, records the withdraw debit — the SAME reserve-at-request
 *      model as manual withdrawals
 *   3. executeWithdrawalPayout() (shared engine) runs the KYC-gated,
 *      outbox-protected Razorpay X payout — identical semantics to admin pay
 *
 * Safety properties:
 *   - At most ONE active auto withdrawal per tech (unique partial index on
 *     {technicianId, type, status} — a second cron run fails the insert).
 *   - Balance is re-checked INSIDE the creation transaction — no overspend.
 *   - Auto payouts do NOT count toward the manual 7-day withdrawal cooldown
 *     and are exempt from the "no duplicate pending" rule that manual
 *     requests enforce.
 *   - Stuck/ambiguous payouts land in manual_review / approved and are
 *     recovered by the existing 10-min reconciliation cron.
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

/**
 * Create (pre-approved, balance reserved) + immediately execute the payout
 * for one technician. Called per eligible tech inside processAutoPayouts().
 *
 * @returns {Promise<{status: string, withdrawalId: string}|null>} null when
 *          skipped (already active / no longer eligible)
 */
export const createAndProcessAutoPayout = async (technicianId, config) => {
  const session = await mongoose.startSession();
  let withdrawalId = null;
  try {
    await session.withTransaction(async () => {
      // Re-check eligibility INSIDE the txn against a fresh profile read —
      // the cron's snapshot may be stale (another payout ran in between).
      const tech = await TechnicianProfile.findById(technicianId)
        .select("availableBalancePaise payoutSettings")
        .session(session)
        .lean();
      if (!tech) throw new Error(`Technician ${technicianId} not found`);

      const calc = computeAutoPayoutForTech(tech, config);
      if (!calc.eligible) {
        throw new Error(`skip:${calc.reason}`);
      }

      // O1 — do NOT auto-pay-out while a complaint payout-block is active for
      // this technician (reserve must stay frozen until the complaint resolves).
      if (await hasActivePayoutBlock(technicianId, { session })) {
        throw new Error("skip:payout_blocked:open_complaint");
      }

      // O2 — do not auto-pay-out while outstanding dues remain; dues are
      // recovered from earnings, not by shrinking the payout.
      if ((tech.outstandingDuesPaise || 0) > 0) {
        throw new Error("skip:outstanding_dues");
      }

      // Race guard — the unique partial index {technicianId, type, status}
      // on active auto statuses backs this up with a duplicate-key error.
      const active = await WithdrawalRequest.findOne({
        technicianId,
        type: "auto",
        status: { $in: ["pending", "requested", "approved", "processing"] },
      })
        .session(session)
        .select("_id")
        .lean();
      if (active) {
        throw new Error(`skip:already_active:${active._id}`);
      }

      const amountPaiseNum = calc.amountPaise;

      // Reserve the balance — O5: clamp the available debit so the wallet can
      // NEVER go negative even under a concurrent credit/payout race.
      await safeDebitAvailable({ technicianId, amountPaise: amountPaiseNum, session });

      // Pre-approved auto request (manual step skipped by design) + reserve
      // the balance — same reserve-at-request model as manual withdrawals.
      const [withdrawal] = await WithdrawalRequest.create(
        [
          {
            technicianId,
            amountPaise: amountPaiseNum,
            amount: paiseToRupees(amountPaiseNum),
            type: "auto",
            status: "approved",
            autoApproved: true,
            autoApprovedAt: new Date(),
            autoApprovedReason: `Balance ₹${paiseToRupees(tech.availableBalancePaise ?? 0).toFixed(2)} exceeded auto-payout threshold ₹${paiseToRupees(calc.settings.autoPayoutThresholdPaise).toFixed(2)}`,
            minimumMaintenancePaise: calc.settings.minimumMaintenancePaise,
            approvedAt: new Date(),
            decidedAt: new Date(),
            adminNote: "Auto-approved by system (threshold-based auto-payout)",
          },
        ],
        { session }
      );
      withdrawalId = String(withdrawal._id);

      // Reserve (hold) the payout obligation. The available debit was already
      // done above via safeDebitAvailable (clamped, never negative).
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        {
          $inc: {
            reservedBalancePaise: amountPaiseNum,
          },
        },
        { session }
      );

      await WalletTransaction.create(
        [
          {
            technicianId,
            amountPaise: amountPaiseNum,
            amount: paiseToRupees(amountPaiseNum),
            type: "debit",
            source: "withdraw",
            withdrawalId: withdrawal._id,
            idempotencyKey: `withdrawal:${withdrawal._id}`,
            note: `Auto-payout (threshold exceeded) – withdrawal #${withdrawal._id}`,
          },
        ],
        { session }
      );
    });

    await writeAuditLog({
      actorRole: "System",
      action: "AUTO_PAYOUT_CREATED",
      targetType: "WithdrawalRequest",
      targetId: withdrawalId,
      after: { type: "auto", status: "approved", initiatedBy: "system" },
      reason: "Threshold-based auto-payout",
    });

    // Execute through the SHARED payout engine (KYC gates + outbox +
    // reconciliation semantics identical to admin-initiated payouts).
    const io = getIo();
    return await executeWithdrawalPayout({
      withdrawalId,
      actor: null, // system-initiated
      narration: "RightTouch Auto-Payout (threshold exceeded)",
      adminNote: "Auto-payout — system initiated",
      io,
    });
  } catch (error) {
    const msg = String(error?.message || "");
    if (msg.startsWith("skip:")) {
      console.log(`[AutoPayout] Skip tech ${technicianId}: ${msg.slice(5)}`);
      return null;
    }
    // Duplicate-key race: another run created the auto-payout first.
    if (error?.code === 11000) {
      console.log(`[AutoPayout] Skip tech ${technicianId}: concurrent auto-payout already created`);
      return null;
    }
    // Payout-engine failures are already statused (manual_review / approved
    // revert); the reconciliation cron + admin dashboard take over from here.
    console.error(`[AutoPayout] Failed for tech ${technicianId}:`, error.message);
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Cron entry — scan high-balance technicians and auto-payout the eligible.
 * Batches a bounded number per run (100) so a single cron tick can never
 * flood Razorpay X.
 *
 * @param {object} [io] — optional socket.io instance (falls back to getIo())
 * @returns {Promise<{processed: number, skipped: number, failed: number}>}
 */
export const processAutoPayouts = async (io = null) => {
  const startedAt = Date.now();
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const config = await getAutoPayoutConfig();
    if (!config.autoPayoutEnabled) {
      console.log("[AutoPayout] Disabled (global config/env) — skipping run");
      return { processed, skipped, failed, enabled: false };
    }

    // Pre-filter: only techs that could possibly be eligible. Threshold can
    // only go DOWN per-tech, and payout can never be below ₹100, so any
    // eligible tech has balance >= ₹100 (MIN_AUTO_PAYOUT_PAISE).
    const candidates = await TechnicianProfile.find({
      availableBalancePaise: { $gte: MIN_AUTO_PAYOUT_PAISE },
    })
      .select("_id availableBalancePaise outstandingDuesPaise payoutSettings")
      .sort({ availableBalancePaise: -1 })
      .limit(100)
      .lean();

    for (const tech of candidates) {
      const calc = computeAutoPayoutForTech(tech, config);
      if (!calc.eligible) {
        skipped++;
        continue;
      }
      try {
        const result = await createAndProcessAutoPayout(tech._id, config);
        if (result) processed++;
        else skipped++;
      } catch (err) {
        failed++;
        console.error(`[AutoPayout] Tech ${tech._id} failed:`, err.message);
      }
    }

    console.log(
      `[AutoPayout] Run complete in ${Date.now() - startedAt}ms: ${processed} processed, ${skipped} skipped, ${failed} failed`
    );
    return { processed, skipped, failed, enabled: true };
  } catch (error) {
    console.error("[AutoPayout] processAutoPayouts error:", error.message);
    return { processed, skipped, failed, enabled: false, error: error.message };
  }
};