import TechnicianProfile from "../../modules/technician/models/TechnicianProfile.js";

/* ================= TECHNICIAN ONLY =================
 * Must run AFTER Auth (which already resolved + vetted technicianProfileId,
 * including the suspended/deleted blocks). This layer re-verifies because
 * technician routes are the safety-critical surface (job accept/complete →
 * money), so a stale req.user must never slip through:
 *  - ownership: profile.userId must equal the token userId
 *  - liveness: deleted/suspended profiles are rejected even if Auth was bypassed
 * Uses .lean() (no Mongoose hydration): consumers only read fields.
 */
const isTechnician = async (req, res, next) => {
  try {
    // 1️⃣ Role check
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Technician only.",
      });
    }


    // 2️⃣ Profile check
    const profileId = req.user.technicianProfileId;
    if (!profileId) {
      return res.status(403).json({
        success: false,
        message: "Technician profile not found",
      });
    }

    const technician = await TechnicianProfile.findById(profileId).lean();
    if (!technician) {
      return res.status(403).json({
        success: false,
        message: "Technician profile not found",
      });
    }

    // 3️⃣ Ownership check — the profile must belong to the token owner
    if (String(technician.userId) !== String(req.user.userId)) {
      return res.status(403).json({
        success: false,
        message: "Technician profile mismatch",
      });
    }

    // 4️⃣ Liveness check — defense in depth behind Auth's own block
    if (technician.workStatus === "deleted") {
      return res.status(403).json({
        success: false,
        message: "Technician profile not found",
      });
    }
    if (technician.workStatus === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Technician account is suspended. Contact support.",
      });
    }

    // 5️⃣ Attach technician to request
    req.technician = technician;

    next();
  } catch (error) {
    console.error("isTechnician Middleware - Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

export default isTechnician;
