import TechnicianProfile from "../Schemas/TechnicianProfile.js";

/* ================= TECHNICIAN ONLY ================= */
const isTechnician = async (req, res, next) => {
  try {
    // 1️⃣ Role check
    if (req.user.role !== "Technician") {
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

    const technician = await TechnicianProfile.findById(profileId).select("-password");
    if (!technician) {
      return res.status(403).json({
        success: false,
        message: "Technician profile not found",
      });
    }

    // H5: suspended/deleted technicians are rejected at every technician-gated
    // entry point, even if they present an otherwise valid session.
    if (technician.workStatus === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Technician account suspended. Contact support.",
      });
    }
    if (technician.workStatus === "deleted") {
      return res.status(403).json({
        success: false,
        message: "Technician profile not found",
      });
    }

    // 3️⃣ Attach technician to request
    req.technician = technician;

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

export default isTechnician;
