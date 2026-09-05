import mongoose from "mongoose";
import ProductBooking from "../Schemas/ProductBooking.js";
import Product from "../Schemas/Product.js";
import { buildProductFinancialSnapshot, validateProductAmountAgainstCatalog } from "../Utils/productPricing.js";
import { buildPaymentDetailsSummary } from "../Utils/paymentReadModel.js";

const ensureAdminOrOwner = (req) => {
  const role = (req.user?.role || "").toLowerCase();
  if (role !== "admin" && role !== "owner") {
    const err = new Error("Admin or Owner access only");
    err.statusCode = 403;
    throw err;
  }
};

const toNumber = value => {
  const num = Number(value);
  return Number.isNaN(num) ? NaN : num;
};


const ensureCustomer = (req) => {
  if (!req.user || req.user.role !== "Customer") {
    const err = new Error("Customer access only");
    err.statusCode = 403;
    throw err;
  }
  if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
    const err = new Error("Invalid token: userId missing");
    err.statusCode = 401;
    throw err;
  }
};

export const getAllProductBooking = async (req, res) => {
  try {
    const role = req.user?.role?.toLowerCase();
    const { status } = req.query;

    let filter = {};
    if (role !== "admin" && role !== "owner") {
      filter.customerId = req.user.userId;
    }

    if (status) {
      const statusArray = status.split(",").map(s => s.trim()).filter(s => s.length > 0);
      if (statusArray.length > 0) {
        filter.status = { $in: statusArray };
      }
    }

    const getAllBooking = await ProductBooking.find(filter)
      .populate("customerId", "fname lname gender mobileNumber")
      .populate("productId", "productName pricingModel estimatedPriceFrom estimatedPriceTo")
      .populate({
        path: "paymentId",
        select: "provider mode providerPaymentId offlineDetails verifiedAt status"
      })
      .sort({ createdAt: -1 });

    const result = getAllBooking.map((b) => {
      const o = b.toObject ? b.toObject() : { ...b };
      if (role !== "admin" && role !== "owner" && o.financialSnapshot) {
        delete o.financialSnapshot.commissionPercentage;
        delete o.financialSnapshot.commissionAmountPaise;
        delete o.financialSnapshot.technicianAmountPaise;
        delete o.commissionAmount;
        delete o.commissionAmountPaise;
        delete o.technicianAmount;
        delete o.technicianAmountPaise;
      }
      const paymentDoc = o.paymentId || null;
      o.paymentDetailsSummary = paymentDoc
        ? buildPaymentDetailsSummary(paymentDoc)
        : (o.paymentStatus === "paid" ? `Paid via ${o.paymentMode ? o.paymentMode.toUpperCase() : "Online"}${o.paymentProviderPaymentId ? ` (Ref: ${o.paymentProviderPaymentId})` : ""}` : null);
      return o;
    });

    res.status(200).json({
      success: true,
      message: "Data fetched successfully",
      result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching product bookings",
      result: { error: error.message },
    });
  }
};

export const getProductBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format", result: {} });
    }
    const role = req.user?.role?.toLowerCase();
    const filter = { _id: id };
    if (role !== "admin" && role !== "owner") {
      filter.customerId = req.user.userId;
    }
    const booking = await ProductBooking.findOne(filter)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("productId", "productName productType productImages")
      .populate("quoteRequestId")
      .populate("quotationId")
      .populate({
        path: "paymentId",
        select: "provider mode providerPaymentId offlineDetails verifiedAt status"
      });

    if (!booking) {
      return res.status(404).json({ success: false, message: "Product booking not found", result: {} });
    }

    const obj = booking.toObject ? booking.toObject() : { ...booking };
    if (role !== "admin" && role !== "owner" && obj.financialSnapshot) {
      delete obj.financialSnapshot.commissionPercentage;
      delete obj.financialSnapshot.commissionAmountPaise;
      delete obj.financialSnapshot.technicianAmountPaise;
    }
    const paymentDoc = obj.paymentId || null;
    obj.paymentDetailsSummary = paymentDoc
      ? buildPaymentDetailsSummary(paymentDoc)
      : (obj.paymentStatus === "paid" ? `Paid via ${obj.paymentMode ? obj.paymentMode.toUpperCase() : "Online"}${obj.paymentProviderPaymentId ? ` (Ref: ${obj.paymentProviderPaymentId})` : ""}` : null);

    res.status(200).json({ success: true, message: "Booking fetched successfully", result: obj });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching product booking", result: { error: error.message } });
  }
};


export const productBookingUpdate = async (req, res) => {
  try {
    ensureCustomer(req);
    const customerId = req.user.userId;

    const { id } = req.params;
    const { amount, paymentStatus, status, quantity } = req.body;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID format",
        result: {},
      });
    }

    // 🔒 SECURITY: a product order's money fields and payment status are
    // server-derived. `amount`, `quantity`, and `paymentStatus` are NOT
    // customer-editable — changing the amount/quantity would let a customer
    // lower the payable amount, and setting `paymentStatus: "paid"` would let
    // them bypass payment entirely. An order can only be marked paid through
    // the verified Razorpay pipeline (order → capture → webhook/verify).
    const booking = await ProductBooking.findOne({ _id: id, customerId }).select("paymentStatus status");
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    }

    // 🔒 SECURITY: completion (active → completed) is an ADMIN/SYSTEM-only
    // transition. A customer must never be able to flip a product booking to
    // "completed" themselves — otherwise they could rate a product without it
    // actually being delivered/fulfilled. Likewise `paymentStatus` and `amount`
    // are server-derived via the Razorpay pipeline. The only customer-editable
    // field is `quantity`, and only while the booking is unpaid.
    const update = {};

    if (status !== undefined) {
      return res.status(403).json({
        success: false,
        message: "Product booking status is server-controlled and cannot be changed by the customer",
        result: {},
      });
    }

    if (paymentStatus !== undefined || amount !== undefined) {
      return res.status(403).json({
        success: false,
        message: "Payment status and amount are server-controlled",
        result: {},
      });
    }

    if (quantity !== undefined) {
      if (booking.paymentStatus === "paid") {
        return res.status(409).json({
          success: false,
          message: "Cannot modify a booking that is already paid",
          result: {},
        });
      }
      update.quantity = quantity;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update", result: {} });
    }

    const updateBooking = await ProductBooking.findOneAndUpdate(
      { _id: id, customerId },
      update,
      { new: true, runValidators: true, context: "query" }
    );

    if (!updateBooking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Booking updated successfully",
      result: updateBooking,
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

export const productBookingCancel = async (req, res) => {
  try {
    ensureCustomer(req);
    const customerId = req.user.userId;

    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID is required",
        result: {}
      });
    }

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID format",
        result: {},
      });
    }

    const booking = await ProductBooking.findOne({ _id: id, customerId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Your booking was not found",
        result: {}
      });
    }

    if (["ready_for_delivery", "out_for_delivery", "completed"].includes(booking.status)) {
      return res.status(409).json({
        success: false,
        message: `Order cannot be cancelled in '${booking.status}' status. Please contact customer support.`,
        result: {}
      });
    }

    booking.status = "cancelled";
    await booking.save();

    res.status(200).json({
      success: true,
      message: "Your booking has been cancelled successfully",
      result: booking
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      success: false,
      message: "Server error",
      result: { error: error.message }
    });
  }
};

/* ===============================
   ADMIN / OWNER — MARK PRODUCT BOOKING COMPLETED
   Completion (active → completed) is the rating gate. It is strictly
   server-controlled: a product can only be rated once it is actually
   delivered/fulfilled, never merely because payment succeeded.
   Cancelled bookings can never be completed.
   =============================== */
export const adminCompleteProductBooking = async (req, res) => {
  try {
    ensureAdminOrOwner(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format", result: {} });
    }

    const booking = await ProductBooking.findById(id);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Product booking not found", result: {} });
    }

    if (booking.status === "cancelled") {
      return res.status(409).json({
        success: false,
        message: "Cancelled product bookings cannot be completed",
        result: {},
      });
    }

    if (booking.status === "completed") {
      return res.status(200).json({
        success: true,
        message: "Product booking is already completed",
        result: booking,
      });
    }

    booking.status = "completed";
    await booking.save();

    res.status(200).json({
      success: true,
      message: "Product booking marked as completed",
      result: booking,
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      success: false,
      message: "Server error",
      result: { error: error.message }
    });
  }
};
