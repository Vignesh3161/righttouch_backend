import ProductBooking from "../Schemas/ProductBooking.js";
import Quotation from "../Schemas/Quotation.js";
import Payment from "../Schemas/Payment.js";
import Product from "../Schemas/Product.js";
import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import Receipt from "../Schemas/Receipt.js";
import AuditLog from "../Schemas/AuditLog.js";

/**
 * Common Settlement Engine for Product Payments (Online Gateway Verification & Admin Manual Settlement)
 */
export const settleProductPayment = async ({
  bookingId,
  paymentMode = "cash",
  provider = "offline",
  providerPaymentId = null,
  providerOrderId = null,
  providerSignature = null,
  amountPaise = null,
  recordedBy = null,
  notes = "",
  source = "admin_manual"
}) => {
  let booking = await ProductBooking.findById(bookingId);
  let quotation = null;
  if (!booking) {
    quotation = await Quotation.findById(bookingId);
    if (quotation) {
      booking = await ProductBooking.findOne({ quotationId: quotation._id });
    }
  } else if (booking.quotationId) {
    quotation = await Quotation.findById(booking.quotationId);
  }

  if (!booking && !quotation) {
    const err = new Error("Product booking or quotation not found");
    err.statusCode = 404;
    throw err;
  }

  if (booking && booking.paymentStatus === "paid") {
    if (quotation && quotation.paymentStatus !== "paid") {
      quotation.paymentStatus = "paid";
      await quotation.save().catch(() => {});
    }
    return { success: true, alreadyPaid: true, booking };
  }

  const targetPaise = amountPaise != null
    ? amountPaise
    : (booking.amountPaise || (booking.amount ? Math.round(booking.amount * 100) : 0));

  const modeNormalized = String(paymentMode).toLowerCase();
  const refId = providerPaymentId || `OFFLINE_${modeNormalized.toUpperCase()}_${Date.now()}`;

  let payment = await Payment.findOne({ bookingId: booking._id });

  if (!payment) {
    payment = await Payment.create({
      bookingId: booking._id,
      itemType: "product",
      provider,
      mode: modeNormalized,
      currency: "INR",
      idempotencyKey: `settle-product:${booking._id}`,
      baseAmountPaise: targetPaise,
      totalAmountPaise: targetPaise,
      commissionPercentage: 0,
      commissionAmountPaise: 0,
      technicianAmountPaise: targetPaise,
      gstAmountPaise: booking.financialSnapshot?.gstAmountPaise ?? 0,
      status: "success",
      providerOrderId,
      providerPaymentId: refId,
      providerSignature,
      verifiedAt: new Date(),
      offlineDetails: source === "admin_manual" ? {
        transactionReference: refId,
        receivedAt: new Date(),
        recordedBy,
        notes: notes || `Admin settled payment via ${paymentMode}`,
      } : undefined
    });
  } else {
    payment.provider = provider;
    payment.mode = modeNormalized;
    payment.status = "success";
    payment.providerPaymentId = refId;
    if (providerOrderId) payment.providerOrderId = providerOrderId;
    if (providerSignature) payment.providerSignature = providerSignature;
    payment.verifiedAt = new Date();
    if (source === "admin_manual") {
      payment.offlineDetails = {
        transactionReference: refId,
        receivedAt: new Date(),
        recordedBy,
        notes: notes || `Admin settled payment via ${paymentMode}`,
      };
    }
    await payment.save();
  }

  // Update Product Booking Payment Status & Status
  booking.paymentStatus = "paid";
  booking.paymentMode = modeNormalized;
  booking.paymentProvider = provider;
  booking.paymentId = payment._id;
  booking.paymentProviderPaymentId = refId;
  booking.paidAmountPaise = targetPaise;
  booking.paidAmount = targetPaise / 100;
  if (booking.status === "active" || booking.status === "pending") {
    booking.status = "processing";
  }
  await booking.save();

  if (quotation) {
    quotation.paymentStatus = "paid";
    await quotation.save().catch(() => {});
  }

  // Stock updates: transition reserved quantity to sold quantity
  if (booking.productId) {
    try {
      const prod = await Product.findById(booking.productId);
      if (prod) {
        const qty = booking.quantity || 1;
        prod.reservedQuantity = Math.max(0, (prod.reservedQuantity || 0) - qty);
        prod.soldQuantity = (prod.soldQuantity || 0) + qty;
        const available = Math.max(0, (prod.stockQuantity || 0) - prod.reservedQuantity);
        if (available <= 0) {
          prod.status = "OUT_OF_STOCK";
        } else if (available <= (prod.lowStockThreshold || 5)) {
          prod.status = "LOW_STOCK";
        }
        await prod.save();
      }
    } catch (e) {
      console.error("Stock settlement sync non-fatal error:", e);
    }
  }

  // Ledger entry & Receipt creation
  try {
    await PlatformLedgerEntry.create({
      bookingId: booking._id,
      itemType: "product",
      entryType: "PRODUCT_SALE",
      amountPaise: targetPaise,
      currency: "INR",
      paymentId: payment._id,
      source,
      notes: `Settlement for product booking ${booking._id}`
    }).catch(() => {});

    await Receipt.create({
      bookingId: booking._id,
      paymentId: payment._id,
      receiptNumber: `RCP-${Date.now()}`,
      amountPaise: targetPaise,
      issuedAt: new Date(),
      status: "issued"
    }).catch(() => {});
  } catch (e) {
    console.error("Ledger/Receipt posting non-fatal error:", e);
  }

  // Audit Log
  try {
    await AuditLog.create({
      actor: recordedBy,
      action: "PRODUCT_PAYMENT_SETTLED",
      targetType: "ProductBooking",
      targetId: booking._id,
      after: {
        paymentStatus: "paid",
        amountPaise: targetPaise,
        mode: paymentMode,
        refId
      },
      reason: notes || `Settlement source: ${source}`
    }).catch(() => {});
  } catch (e) {}

  return { success: true, payment, booking };
};

/**
 * Get dedicated Product Payments list with rich filtering
 */
export const getProductPaymentsList = async ({ query = {} }) => {
  const { status, mode, provider, search, startDate, endDate, page = 1, limit = 20 } = query;

  const filter = { itemType: "product" };

  if (status) filter.status = status;
  if (mode) filter.mode = mode;
  if (provider) filter.provider = provider;

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skipNum = (pageNum - 1) * limitNum;

  const total = await Payment.countDocuments(filter);
  const payments = await Payment.find(filter)
    .populate({
      path: "bookingId",
      populate: [
        { path: "customerId", select: "name phone email" },
        { path: "productId", select: "productName productImages productType" }
      ]
    })
    .sort({ createdAt: -1 })
    .skip(skipNum)
    .limit(limitNum);

  return {
    payments,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum)
    }
  };
};

/**
 * Get Product Payments KPI Financial Summary
 */
export const getProductPaymentsSummary = async () => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalPaid,
    totalPending,
    totalFailed,
    manualPaid,
    onlinePaid,
    todayPaid,
    weekPaid,
    monthPaid
  ] = await Promise.all([
    Payment.aggregate([{ $match: { itemType: "product", status: "success" } }, { $group: { _id: null, sum: { $sum: "$totalAmountPaise" } } }]),
    Payment.aggregate([{ $match: { itemType: "product", status: "pending" } }, { $group: { _id: null, sum: { $sum: "$totalAmountPaise" } } }]),
    Payment.aggregate([{ $match: { itemType: "product", status: "failed" } }, { $group: { _id: null, sum: { $sum: "$totalAmountPaise" } } }]),
    Payment.aggregate([{ $match: { itemType: "product", status: "success", provider: "offline" } }, { $group: { _id: null, sum: { $sum: "$totalAmountPaise" } } }]),
    Payment.aggregate([{ $match: { itemType: "product", status: "success", provider: "razorpay" } }, { $group: { _id: null, sum: { $sum: "$totalAmountPaise" } } }]),
    Payment.aggregate([{ $match: { itemType: "product", status: "success", createdAt: { $gte: startOfToday } } }, { $group: { _id: null, sum: { $sum: "$totalAmountPaise" } } }]),
    Payment.aggregate([{ $match: { itemType: "product", status: "success", createdAt: { $gte: startOfWeek } } }, { $group: { _id: null, sum: { $sum: "$totalAmountPaise" } } }]),
    Payment.aggregate([{ $match: { itemType: "product", status: "success", createdAt: { $gte: startOfMonth } } }, { $group: { _id: null, sum: { $sum: "$totalAmountPaise" } } }])
  ]);

  return {
    totalSalesPaise: totalPaid[0]?.sum || 0,
    paidPaise: totalPaid[0]?.sum || 0,
    pendingPaise: totalPending[0]?.sum || 0,
    failedPaise: totalFailed[0]?.sum || 0,
    manualPaymentsPaise: manualPaid[0]?.sum || 0,
    onlinePaymentsPaise: onlinePaid[0]?.sum || 0,
    todaySalesPaise: todayPaid[0]?.sum || 0,
    weekSalesPaise: weekPaid[0]?.sum || 0,
    monthSalesPaise: monthPaid[0]?.sum || 0,
  };
};
