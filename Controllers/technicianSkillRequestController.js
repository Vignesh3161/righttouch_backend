import mongoose from "mongoose";
import TechnicianSkillRequest from "../Schemas/TechnicianSkillRequest.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import Service from "../Schemas/Service.js";
import CityZone from "../Schemas/CityZone.js";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import { writeAuditLog } from "../Utils/audit.js";
import { sendPushNotification } from "../Utils/sendNotification.js";
import Notification from "../Schemas/Notification.js";

const isValidObjectId = mongoose.Types.ObjectId.isValid;

/**
 * 📋 ADMIN: LIST ALL TECHNICIAN SKILL REQUESTS
 * Supports filtering by status, district, zone, technicianId, search & pagination.
 */
export const listTechnicianSkillRequests = async (req, res) => {
  try {
    const {
      status,
      districtId,
      zoneId,
      technicianId,
      page = 1,
      limit = 20,
      search,
    } = req.query;

    const query = {};

    if (status && status !== "all") {
      query.status = status;
    }

    if (districtId && isValidObjectId(districtId)) {
      query.districtId = districtId;
    }

    if (zoneId && isValidObjectId(zoneId)) {
      query.zoneId = zoneId;
    }

    if (technicianId && isValidObjectId(technicianId)) {
      query.technicianId = technicianId;
    }

    if (search && typeof search === "string" && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      query.$or = [
        { serviceName: searchRegex },
        { reason: searchRegex },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [requests, total] = await Promise.all([
      TechnicianSkillRequest.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate({
          path: "technicianId",
          select: "userId primaryDistrictId cityZoneId experienceYears specialization workStatus profileComplete",
          populate: {
            path: "userId",
            select: "fname lname mobileNumber email profileImage",
          },
        })
        .populate("serviceId", "serviceName image category price")
        .populate("districtId", "name code state")
        .populate("zoneId", "name zoneCode")
        .populate("reviewedBy", "fname lname")
        .lean(),
      TechnicianSkillRequest.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      message: "Technician skill requests fetched successfully",
      result: {
        requests,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error) {
    console.error("listTechnicianSkillRequests Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching skill requests",
      result: { error: error.message },
    });
  }
};

/**
 * ⚖️ ADMIN: REVIEW (APPROVE / REJECT) TECHNICIAN SKILL REQUEST
 */
export const reviewTechnicianSkillRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action, adminRemarks, autoEnableInZone = true } = req.body;

    if (!isValidObjectId(requestId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Request ID",
        result: {},
      });
    }

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Action must be either 'approve' or 'reject'",
        result: {},
      });
    }

    const skillReq = await TechnicianSkillRequest.findById(requestId);
    if (!skillReq) {
      return res.status(404).json({
        success: false,
        message: "Skill request not found",
        result: {},
      });
    }

    if (skillReq.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Request has already been ${skillReq.status}`,
        result: { currentStatus: skillReq.status },
      });
    }

    const adminUserId = req.user?.userId;
    const serviceDoc = await Service.findById(skillReq.serviceId).select("serviceName").lean();
    const serviceName = serviceDoc?.serviceName || skillReq.serviceName || "Service";

    if (action === "approve") {
      // 1. Add skill to TechnicianProfile if not already present
      const techProfile = await TechnicianProfile.findById(skillReq.technicianId);
      if (techProfile) {
        const hasSkill = (techProfile.skills || []).some(
          (s) => String(s.serviceId) === String(skillReq.serviceId)
        );

        if (!hasSkill) {
          techProfile.skills.push({
            serviceId: skillReq.serviceId,
            experienceYears: Number(skillReq.experienceYears) || 0,
          });
          await techProfile.save();
        }
      }

      // 2. Optionally enable the service for the whole zone. The mandatory
      // mapping alone is not enough: the resolver also reads the canonical
      // ZONE availability row (new zones are seeded DISABLED), so both must
      // be written together.
      if (autoEnableInZone && skillReq.zoneId) {
        const zone = await CityZone.findById(skillReq.zoneId)
          .select("operationalCityId active")
          .lean();
        if (!zone) {
          return res.status(404).json({
            success: false,
            message: "The zone for this skill request no longer exists",
          });
        }
        const techZoneIds = (techProfile?.enabledCityZoneIds || []).map((z) =>
          String(z._id || z)
        );
        if (!techZoneIds.includes(String(skillReq.zoneId))) {
          return res.status(400).json({
            success: false,
            message:
              "Technician does not have permission for this zone. Grant the zone before enabling the service.",
            code: "ZONE_PERMISSION_REQUIRED",
          });
        }

        await ZoneServiceMapping.findOneAndUpdate(
          { zoneId: skillReq.zoneId, serviceId: skillReq.serviceId },
          {
            $set: {
              active: true,
              approvedBy: adminUserId || null,
              approvedAt: new Date(),
            },
            $setOnInsert: {
              zoneId: skillReq.zoneId,
              serviceId: skillReq.serviceId,
            },
          },
          { upsert: true, new: true }
        );

        await ServiceAvailability.findOneAndUpdate(
          {
            serviceId: skillReq.serviceId,
            districtId: zone.operationalCityId,
            cityZoneId: skillReq.zoneId,
            scope: "ZONE",
          },
          {
            $set: {
              serviceId: skillReq.serviceId,
              districtId: zone.operationalCityId,
              cityZoneId: skillReq.zoneId,
              scope: "ZONE",
              status: "ENABLED",
              updatedBy: adminUserId || null,
            },
          },
          { upsert: true, new: true }
        );
      }

      // 3. Mark request approved
      skillReq.status = "approved";
      skillReq.adminRemarks = adminRemarks || "Approved by Admin";
      skillReq.reviewedBy = adminUserId || null;
      skillReq.reviewedAt = new Date();
      await skillReq.save();

      // 4. Audit Log
      await writeAuditLog({
        actor: adminUserId,
        actorRole: req.user?.role || "Admin",
        action: "TECHNICIAN_SKILL_REQUEST_APPROVED",
        targetType: "TechnicianSkillRequest",
        targetId: skillReq._id,
        metadata: {
          technicianId: skillReq.technicianId,
          serviceId: skillReq.serviceId,
          serviceName,
          zoneId: skillReq.zoneId,
          autoEnableInZone,
        },
      });

      // 5. In-App + Push Notification to Technician
      try {
        await Notification.create({
          userId: skillReq.userId,
          title: "🎉 Skill Approved!",
          message: `Your request to provide ${serviceName} has been approved. You are now eligible to receive bookings for this service.`,
          type: "SYSTEM",
          metadata: { serviceId: skillReq.serviceId, requestId: skillReq._id },
        });

        const techTokens = (await TechnicianProfile.findById(skillReq.technicianId).select("fcmTokens").lean())?.fcmTokens || [];
        if (techTokens.length > 0) {
          await sendPushNotification(
            techTokens,
            "🎉 Skill Approved!",
            `Your request for ${serviceName} has been approved!`,
            { type: "SKILL_APPROVED", serviceId: String(skillReq.serviceId) }
          );
        }
      } catch (notifErr) {
        console.warn("Notification dispatch failed:", notifErr.message);
      }

      return res.status(200).json({
        success: true,
        message: `Skill '${serviceName}' approved and added to technician profile successfully`,
        result: skillReq,
      });
    } else {
      // Reject
      skillReq.status = "rejected";
      skillReq.adminRemarks = adminRemarks || "Rejected by Admin";
      skillReq.reviewedBy = adminUserId || null;
      skillReq.reviewedAt = new Date();
      await skillReq.save();

      // Audit Log
      await writeAuditLog({
        actor: adminUserId,
        actorRole: req.user?.role || "Admin",
        action: "TECHNICIAN_SKILL_REQUEST_REJECTED",
        targetType: "TechnicianSkillRequest",
        targetId: skillReq._id,
        metadata: {
          technicianId: skillReq.technicianId,
          serviceId: skillReq.serviceId,
          serviceName,
          reason: adminRemarks,
        },
      });

      // Notification
      try {
        await Notification.create({
          userId: skillReq.userId,
          title: "Skill Request Update",
          message: `Your request to provide ${serviceName} was not approved.${adminRemarks ? ` Reason: ${adminRemarks}` : ""}`,
          type: "SYSTEM",
          metadata: { serviceId: skillReq.serviceId, requestId: skillReq._id },
        });
      } catch (notifErr) {
        console.warn("Notification dispatch failed:", notifErr.message);
      }

      return res.status(200).json({
        success: true,
        message: `Skill request for '${serviceName}' rejected`,
        result: skillReq,
      });
    }
  } catch (error) {
    console.error("reviewTechnicianSkillRequest Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error reviewing skill request",
      result: { error: error.message },
    });
  }
};
