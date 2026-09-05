import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import technicianDistrictService from "../Services/technicianDistrictService.js";

const isOwnerOrAdmin = (req) => ["Owner", "Admin"].includes(req.user?.role);
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

/* =====================================================
   GET TECHNICIAN DISTRICT PERMISSIONS
   GET /api/admin/technicians/:technicianId/districts
===================================================== */
export const getTechnicianDistricts = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { technicianId } = req.params;
    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({ success: false, message: "Invalid technician ID", result: {} });
    }

    const profile = await TechnicianProfile.findById(technicianId)
      .populate("primaryCityId", "name city state country active isRegistrationEnabled isJobEnabled")
      .lean();

    if (!profile) {
      return res.status(404).json({ success: false, message: "Technician profile not found", result: {} });
    }

    // Auto-heal primary district if null
    if (!profile.primaryCityId) {
      await technicianDistrictService.getAllowedDistrictsForTechnician(profile);
    }

    const permissions = await TechnicianDistrictPermission.find({ technicianId })
      .populate("districtId", "name city state country active isRegistrationEnabled isJobEnabled")
      .populate("enabledBy", "name email")
      .populate("disabledBy", "name email")
      .lean();

    return res.status(200).json({
      success: true,
      message: "Technician district permissions fetched",
      result: {
        technicianId,
        primaryDistrict: profile.primaryCityId || null,
        additionalPermissions: permissions,
        allowedDistrictIds: await technicianDistrictService.getAllowedDistrictsForTechnician(profile),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   ADD TECHNICIAN ADDITIONAL DISTRICT PERMISSION
   POST /api/admin/technicians/:technicianId/districts
===================================================== */
export const addTechnicianDistrictPermission = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { technicianId } = req.params;
    const { districtId } = req.body;

    if (!isValidObjectId(technicianId) || !isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid technician or district ID", result: {} });
    }

    const result = await technicianDistrictService.addDistrictPermission({
      technicianId,
      districtId,
      adminUserId: req.user.userId,
      adminRole: req.user.role,
    });

    return res.status(200).json({ success: true, message: result.message });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   TOGGLE / ENABLE / DISABLE TECHNICIAN DISTRICT PERMISSION
   PATCH /api/admin/technicians/:technicianId/districts/:districtId
===================================================== */
export const toggleTechnicianDistrictPermission = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { technicianId, districtId } = req.params;
    const { isEnabled } = req.body;

    if (!isValidObjectId(technicianId) || !isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid technician or district ID", result: {} });
    }
    if (isEnabled === undefined) {
      return res.status(400).json({ success: false, message: "isEnabled boolean parameter is required", result: {} });
    }

    const result = await technicianDistrictService.toggleDistrictPermission({
      technicianId,
      districtId,
      isEnabled: Boolean(isEnabled),
      adminUserId: req.user.userId,
      adminRole: req.user.role,
    });

    return res.status(200).json({ success: true, message: result.message });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   REMOVE TECHNICIAN DISTRICT PERMISSION
   DELETE /api/admin/technicians/:technicianId/districts/:districtId
===================================================== */
export const removeTechnicianDistrictPermission = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { technicianId, districtId } = req.params;

    if (!isValidObjectId(technicianId) || !isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid technician or district ID", result: {} });
    }

    const result = await technicianDistrictService.removeDistrictPermission({
      technicianId,
      districtId,
      adminUserId: req.user.userId,
      adminRole: req.user.role,
    });

    return res.status(200).json({ success: true, message: result.message });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message, result: {} });
  }
};
