import GlobalSetting from "../Schemas/GlobalSetting.js";
import { writeAuditLog } from "../Utils/audit.js";

/* =====================================================
   GLOBAL SETTINGS — admin-governed platform policy
   Keys:
     "technician.reacceptPenaltyPercent" — % of booking total
       amount debited from a technician's wallet when they
       re-accept a job they previously cancelled.
===================================================== */

const PENALTY_PERCENT_KEY = "technician.reacceptPenaltyPercent";
const DEFAULT_PENALTY_PERCENT = 0;

export const getSettingValue = async (key, fallback = null) => {
  try {
    const setting = await GlobalSetting.findOne({ key }).lean();
    return setting?.value ?? fallback;
  } catch (err) {
    console.error(`getSettingValue(${key}) Error:`, err.message);
    return fallback;
  }
};

export const getReacceptPenaltyPercent = async () => {
  const value = await getSettingValue(PENALTY_PERCENT_KEY, DEFAULT_PENALTY_PERCENT);
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : DEFAULT_PENALTY_PERCENT;
};

/* ============ ADMIN: GET ============ */
export const getReacceptPenaltySetting = async (req, res) => {
  try {
    const percent = await getReacceptPenaltyPercent();
    return res.status(200).json({
      success: true,
      message: "Re-accept penalty setting fetched",
      result: {
        key: PENALTY_PERCENT_KEY,
        penaltyPercent: percent,
        description:
          "Penalty % of booking total amount debited when a technician re-accepts a job they cancelled.",
      },
    });
  } catch (err) {
    console.error("getReacceptPenaltySetting Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ============ ADMIN: SET ============ */
export const setReacceptPenaltySetting = async (req, res) => {
  try {
    const { penaltyPercent } = req.body;
    if (penaltyPercent === undefined || penaltyPercent === null || penaltyPercent === "") {
      return res.status(400).json({ success: false, message: "penaltyPercent is required" });
    }

    const percent = Number(penaltyPercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return res.status(400).json({ success: false, message: "penaltyPercent must be a number between 0 and 100" });
    }

    const before = await GlobalSetting.findOne({ key: PENALTY_PERCENT_KEY }).lean();

    const setting = await GlobalSetting.findOneAndUpdate(
      { key: PENALTY_PERCENT_KEY },
      {
        $set: {
          value: percent,
          updatedBy: req.user?.userId || null,
          updatedByRole: req.user?.role || null,
          lastUpdatedAt: new Date(),
        },
      },
      { new: true, upsert: true }
    );

    // 🔍 Audited — who changed the global penalty policy
    await writeAuditLog({
      actor: req.user?.userId || null,
      actorRole: req.user?.role || null,
      action: "setting.update",
      targetType: "GlobalSetting",
      targetId: setting._id,
      before: before ? { key: before.key, value: before.value } : null,
      after: { key: setting.key, value: setting.value },
      reason: "Admin updated technician re-accept penalty percentage",
      metadata: { key: PENALTY_PERCENT_KEY },
    });

    return res.status(200).json({
      success: true,
      message: "Re-accept penalty percentage updated",
      result: { key: setting.key, penaltyPercent: setting.value },
    });
  } catch (err) {
    console.error("setReacceptPenaltySetting Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};