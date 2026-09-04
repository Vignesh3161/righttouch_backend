import ProductBooking from "../Schemas/ProductBooking.js";
import Quotation from "../Schemas/Quotation.js";
import Product from "../Schemas/Product.js";
import Payment from "../Schemas/Payment.js";
import AuditLog from "../Schemas/AuditLog.js";
import User from "../Schemas/User.js";

const ok = (res, code, message, result) => res.status(code).json({ success: true, message, result });
const fail = (res, code, message, result = {}) => res.status(code).json({ success: false, message, result });

/**
 * 📊 Product Dashboard Financial & Operational Overview
 */
export const getProductDashboardSummaryController = async (req, res) => {
  try {
    const [
      allBookings,
      productPayments,
      allQuotations,
      productsCount,
      lowStockCount,
      outOfStockCount
    ] = await Promise.all([
      ProductBooking.find({}).lean(),
      Payment.find({ itemType: "product", status: "success" }).lean(),
      Quotation.find({}).lean(),
      Product.countDocuments({}),
      Product.countDocuments({ status: "LOW_STOCK" }),
      Product.countDocuments({ status: "OUT_OF_STOCK" }),
    ]);

    let totalPaidPaise = 0;
    let totalUnpaidPaise = 0;
    let totalPendingPaise = 0;

    let activeBookingsCount = 0;
    let completedBookingsCount = 0;
    let cancelledBookingsCount = 0;

    // Direct aggregation from ProductBookings
    for (const b of allBookings) {
      const amtPaise = b.amountPaise || (b.amount ? Math.round(b.amount * 100) : 0);
      const isPaid = b.paymentStatus === "paid";
      const isCancelled = b.status === "cancelled";

      if (b.status === "active" || b.status === "processing") activeBookingsCount++;
      if (b.status === "completed") completedBookingsCount++;
      if (isCancelled) cancelledBookingsCount++;

      if (isPaid) {
        totalPaidPaise += (b.paidAmountPaise || amtPaise);
      } else if (!isCancelled) {
        totalUnpaidPaise += amtPaise;
        if (b.paymentStatus === "pending") {
          totalPendingPaise += amtPaise;
        }
      }
    }

    // Fallback: Check Payment records for any successful product payments not captured in booking.paidAmountPaise
    for (const p of productPayments) {
      const pPaise = p.totalAmountPaise || (p.totalAmount ? Math.round(p.totalAmount * 100) : 0);
      const matchingBooking = allBookings.find(b => String(b._id) === String(p.bookingId));
      if (!matchingBooking || matchingBooking.paymentStatus !== "paid") {
        totalPaidPaise += pPaise;
      }
    }

    // Fallback: Check Quotations marked paid if ProductBookings list is empty or undercounting
    for (const q of allQuotations) {
      if (q.paymentStatus === "paid" && q.status === "accepted") {
        const qPaise = q.financialSnapshot?.totalAmountPaise || (q.amount ? Math.round(q.amount * 100) : 0);
        const linkedBooking = allBookings.find(b => String(b.quotationId) === String(q._id));
        if (!linkedBooking) {
          totalPaidPaise += qPaise;
        }
      }
    }

    const totalPaid = totalPaidPaise / 100;
    const totalUnpaid = totalUnpaidPaise / 100;
    const totalPending = totalPendingPaise / 100;
    const totalSalesTurnover = totalPaid + totalUnpaid;

    const summaryResult = {
      totalSalesTurnover,
      totalPaid,
      totalUnpaid,
      totalPending,
      totalSalesPaise: totalSalesTurnover * 100,
      paidPaise: totalPaidPaise,
      unpaidPaise: totalUnpaidPaise,
      pendingPaise: totalPendingPaise,
      totalBookingsCount: allBookings.length,
      activeBookingsCount,
      completedBookingsCount,
      cancelledBookingsCount,
      totalProductsCount: productsCount,
      lowStockCount,
      outOfStockCount,
    };

    return res.status(200).json({
      success: true,
      message: "Product dashboard summary fetched successfully",
      result: summaryResult,
      ...summaryResult
    });
  } catch (error) {
    console.error("getProductDashboardSummaryController error:", error);
    return fail(res, 500, "Error fetching product dashboard summary", { error: error.message });
  }
};

/**
 * 📈 Product Sales Reports Engine
 */
export const getSalesReportController = async (req, res) => {
  try {
    const { startDate, endDate, status, paymentStatus, search } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const bookings = await ProductBooking.find(filter)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("productId", "productName productType categoryId productImages")
      .populate("quotationId", "quotationNumber financialSnapshot")
      .populate({
        path: "paymentId",
        select: "provider mode providerPaymentId verifiedAt offlineDetails"
      })
      .sort({ createdAt: -1 })
      .lean();

    let totalSales = 0;
    const reportData = bookings.map((b) => {
      const amt = b.paidAmount || b.amount || (b.amountPaise ? b.amountPaise / 100 : 0);
      if (b.paymentStatus === "paid") {
        totalSales += amt;
      }
      return {
        bookingId: b._id,
        bookingNumber: b._id.toString().slice(-8).toUpperCase(),
        customerName: b.customerId ? `${b.customerId.fname || ""} ${b.customerId.lname || ""}`.trim() : "Valued Customer",
        customerPhone: b.customerId?.mobileNumber || "—",
        productName: b.productId?.productName || "Product Order",
        quantity: b.quantity || 1,
        amount: amt,
        amountPaise: b.amountPaise || amt * 100,
        status: b.status,
        paymentStatus: b.paymentStatus || "pending",
        paymentMode: b.paymentMode || b.paymentId?.mode || "Online",
        transactionRef: b.paymentProviderPaymentId || b.paymentId?.providerPaymentId || "—",
        createdAt: b.createdAt,
        paidAt: b.updatedAt,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Sales report fetched successfully",
      result: reportData,
      data: reportData,
      totalSales,
    });
  } catch (error) {
    console.error("getSalesReportController error:", error);
    return fail(res, 500, "Error fetching sales report", { error: error.message });
  }
};

/**
 * 📜 Product Module Audit Logs
 */
export const getProductAuditLogsController = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, action } = req.query;

    const filter = {
      targetType: { $in: ["Product", "ProductBooking", "Quotation", "Payment", "ProductQuoteRequest"] }
    };

    if (action) filter.action = action;
    if (search) {
      filter.$or = [
        { action: { $regex: search, $options: "i" } },
        { targetId: { $regex: search, $options: "i" } },
        { reason: { $regex: search, $options: "i" } }
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skipNum = (pageNum - 1) * limitNum;

    const total = await AuditLog.countDocuments(filter);
    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skipNum)
      .limit(limitNum)
      .lean();

    return res.status(200).json({
      success: true,
      message: "Audit logs fetched successfully",
      result: logs,
      logs,
      data: logs,
      total,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error("getProductAuditLogsController error:", error);
    return fail(res, 500, "Error fetching audit logs", { error: error.message });
  }
};

export const getAuditLogByIdController = async (req, res) => {
  try {
    const { id } = req.params;
    const log = await AuditLog.findById(id).lean();
    if (!log) {
      return fail(res, 404, "Audit log entry not found");
    }
    return ok(res, 200, "Audit log fetched successfully", log);
  } catch (error) {
    return fail(res, 500, "Error fetching audit log", { error: error.message });
  }
};
