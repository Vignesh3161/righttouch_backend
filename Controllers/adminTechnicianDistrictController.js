import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import technicianDistrictService from "../Services/technicianDistrictService.js";

const isOwnerOrAdmin = (req) => ["Owner", "Admin"].includes(req.user?.role);
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);
// Path params arrive as strings — a frontend null/undefined id becomes the
// literal strings "null"/"undefined" (e.g. DELETE .../districts/null).
// Detect those explicitly so the error tells the caller what actually
// happened instead of a generic "Invalid ID".
const isMissingId = (v) =>
  v === undefined ||
  v === null ||
  ["", "null", "undefined"].includes(String(v).trim().toLowerCase());

const idError = (res, code, message) =>
  res.status(400).json({ success: false, code, message, result: {} });

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

    // Orphaned rows: permission references a district that was deleted
    // (populated districtId === null). They must NOT be rendered as removable
    // district chips — the UI has no districtId to send, which is exactly how
    // DELETE .../districts/null happens. Surface them separately instead.
    const orphanedPermissions = permissions.filter((p) => !p.districtId);
    const activePermissions = permissions.filter((p) => p.districtId);

    return res.status(200).json({
      success: true,
      message: "Technician district permissions fetched",
      result: {
        technicianId,
        primaryDistrict: profile.primaryCityId || null,
        additionalPermissions: activePermissions,
        orphanedPermissions,
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

    if (!isValidObjectId(technicianId)) {
      return idError(res, "INVALID_TECHNICIAN_ID", "Invalid technician ID");
    }
    if (isMissingId(districtId)) {
      return idError(res, "MISSING_DISTRICT_ID", "districtId is required in the request body");
    }
    if (!isValidObjectId(districtId)) {
      return idError(res, "INVALID_DISTRICT_ID", "Invalid district ID");
    }

    const result = await technicianDistrictService.addDistrictPermission({
      technicianId,
      districtId,
      adminUserId: req.user.userId,
      adminRole: req.user.role,
    });

    return res.status(200).json({ success: true, message: result.message });
  } catch (err) {
    return res
      .status(err.statusCode || 400)
      .json({ success: false, code: err.code || "DISTRICT_PERMISSION_ERROR", message: err.message, result: {} });
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

    if (!isValidObjectId(technicianId)) {
      return idError(res, "INVALID_TECHNICIAN_ID", "Invalid technician ID");
    }
    if (isMissingId(districtId)) {
      return idError(
        res,
        "MISSING_DISTRICT_ID",
        "districtId path param is missing (got 'null'/empty). The UI likely tried to toggle the primary district or an orphaned permission whose district was deleted — refresh permissions and retry with a real district ID."
      );
    }
    if (!isValidObjectId(districtId)) {
      return idError(res, "INVALID_DISTRICT_ID", "Invalid district ID");
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
    return res
      .status(err.statusCode || 400)
      .json({ success: false, code: err.code || "DISTRICT_PERMISSION_ERROR", message: err.message, result: {} });
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

    if (!isValidObjectId(technicianId)) {
      return idError(res, "INVALID_TECHNICIAN_ID", "Invalid technician ID");
    }
    if (isMissingId(districtId)) {
      return idError(
        res,
        "MISSING_DISTRICT_ID",
        "districtId path param is missing (got 'null'/empty). The UI likely tried to remove the primary district (which can never be removed this way) or an orphaned permission whose district was deleted — refresh permissions and retry with a real district ID."
      );
    }
    if (!isValidObjectId(districtId)) {
      return idError(res, "INVALID_DISTRICT_ID", "Invalid district ID");
    }

    const result = await technicianDistrictService.removeDistrictPermission({
      technicianId,
      districtId,
      adminUserId: req.user.userId,
      adminRole: req.user.role,
    });

    return res.status(200).json({ success: true, message: result.message });
  } catch (err) {
    return res
      .status(err.statusCode || 400)
      .json({ success: false, code: err.code || "DISTRICT_PERMISSION_ERROR", message: err.message, result: {} });
  }
};
