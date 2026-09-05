import ProductQuoteRequest from "../Schemas/ProductQuoteRequest.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import Report from "../Schemas/Report.js";
import { SOCKET_ROOMS } from "../Utils/socketConstants.js";

// Active status filter for ProductQuoteRequests requiring admin attention
const ACTIVE_QUOTE_STATUSES = [
  "quote_requested",
  "under_review",
  "quotation_prepared",
  "quotation_sent",
  "viewed",
  "expired",
  "rejected"
];

export const calculateAdminUnreadCounts = async () => {
  const [productQuoteRequests, technicianApplications, customerReports] = await Promise.all([
    ProductQuoteRequest.countDocuments({
      isRead: { $ne: true },
      status: { $in: ACTIVE_QUOTE_STATUSES }
    }),
    TechnicianProfile.countDocuments({
      workStatus: "pending",
      isRead: { $ne: true }
    }),
    Report.countDocuments({
      status: "open",
      isRead: { $ne: true }
    })
  ]);

  return {
    productQuoteRequests,
    technicianApplications,
    customerReports
  };
};

export const broadcastAdminUnreadCounts = async (io) => {
  if (!io) return;
  try {
    const counts = await calculateAdminUnreadCounts();
    io.to(SOCKET_ROOMS.ADMIN_DASHBOARD).emit("admin:unread_counts_updated", {
      success: true,
      counts
    });
  } catch (err) {
    console.error("Failed to broadcast admin unread counts:", err.message);
  }
};

export const getAdminUnreadCounts = async (req, res) => {
  try {
    const counts = await calculateAdminUnreadCounts();
    return res.status(200).json({
      success: true,
      message: "Unread counts retrieved successfully",
      counts
    });
  } catch (err) {
    console.error("Error in getAdminUnreadCounts:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to retrieve unread counts"
    });
  }
};

export const markAdminItemRead = async (req, res) => {
  try {
    const { module, id, markAll } = req.body;
    const userId = req.user?.userId;
    const now = new Date();

    if (!module || !["productQuoteRequests", "technicianApplications", "customerReports"].includes(module)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing module name"
      });
    }

    if (module === "productQuoteRequests") {
      if (markAll) {
        await ProductQuoteRequest.updateMany(
          { isRead: { $ne: true }, status: { $in: ACTIVE_QUOTE_STATUSES } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      } else if (id) {
        await ProductQuoteRequest.updateOne(
          { _id: id, isRead: { $ne: true } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      } else {
        await ProductQuoteRequest.updateMany(
          { isRead: { $ne: true }, status: { $in: ACTIVE_QUOTE_STATUSES } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      }
    } else if (module === "technicianApplications") {
      if (markAll) {
        await TechnicianProfile.updateMany(
          { workStatus: "pending", isRead: { $ne: true } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      } else if (id) {
        await TechnicianProfile.updateOne(
          { _id: id, isRead: { $ne: true } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      } else {
        await TechnicianProfile.updateMany(
          { workStatus: "pending", isRead: { $ne: true } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      }
    } else if (module === "customerReports") {
      if (markAll) {
        await Report.updateMany(
          { status: "open", isRead: { $ne: true } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      } else if (id) {
        await Report.updateOne(
          { _id: id, isRead: { $ne: true } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      } else {
        await Report.updateMany(
          { status: "open", isRead: { $ne: true } },
          { $set: { isRead: true, readAt: now, readBy: userId } }
        );
      }
    }

    const updatedCounts = await calculateAdminUnreadCounts();

    if (req.io) {
      req.io.to(SOCKET_ROOMS.ADMIN_DASHBOARD).emit("admin:unread_counts_updated", {
        success: true,
        counts: updatedCounts
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notifications marked as read",
      counts: updatedCounts
    });
  } catch (err) {
    console.error("Error in markAdminItemRead:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to mark item as read"
    });
  }
};
