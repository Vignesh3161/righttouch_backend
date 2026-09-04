import { getCustomerQuotations, getCustomerQuotationById, viewQuotation, getAdminQuotations, getAdminQuotationById, createQuotationDraft, updateQuotationDraft, sendQuotation, resendQuotation, reviseQuotation, updateQuotationPaymentStatus } from "../Services/quotationService.js";
import { acceptQuotation, rejectQuotation } from "../Services/quotationAcceptanceService.js";
import Quotation from "../Schemas/Quotation.js";

const ok = (res, code, message, result) => res.status(code).json({ success: true, message, result: result || {} });
const fail = (res, code, message, result) => res.status(code).json({ success: false, message, result: result || {} });
// Propagate a machine-readable error code when the service attached one.
const failErr = (res, err) => fail(res, err.statusCode || 500, err.message, err.code ? { code: err.code } : {});

/* ----------------------------- Customer ----------------------------- */

export const customerListQuotationsController = async (req, res) => {
  try {
    const quotations = await getCustomerQuotations({ customerId: req.user.userId, query: req.query });
    return ok(res, 200, "Quotations", quotations);
  } catch (err) {
    return failErr(res, err);
  }
};

export const customerGetQuotationController = async (req, res) => {
  try {
    const quotation = await getCustomerQuotationById({ customerId: req.user.userId, id: req.params.id });
    return ok(res, 200, "Quotation", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const customerViewQuotationController = async (req, res) => {
  try {
    const quotation = await viewQuotation({ customerId: req.user.userId, id: req.params.id });
    return ok(res, 200, "Quotation viewed", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const customerAcceptQuotationController = async (req, res) => {
  try {
    // acceptedItemIds (optional) enables partial acceptance of a multi-product
    // quotation (architecture §14/§15): customer accepts a subset, rejects the rest.
    const { acceptedItemIds } = req.body || {};
    const result = await acceptQuotation({
      quotationId: req.params.id,
      customerId: req.user.userId,
      acceptedItemIds,
    });
    return ok(res, 200, "Quotation accepted — order(s) created. Proceed to payment.", {
      bookingIds: result.bookings.map((b) => b._id),
      paymentGroupId: result.paymentGroupId,
      totalAmountPaise: result.bookings.reduce((s, b) => s + (b.amountPaise || 0), 0),
    });
  } catch (err) {
    return failErr(res, err);
  }
};

export const customerRejectQuotationController = async (req, res) => {
  try {
    const quotation = await rejectQuotation({ quotationId: req.params.id, customerId: req.user.userId, reason: req.body.reason });
    return ok(res, 200, "Quotation rejected", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

/* ----------------------------- Admin ----------------------------- */

export const adminCreateQuotationController = async (req, res) => {
  try {
    const quotation = await createQuotationDraft({ adminId: req.user.userId, body: req.body });
    return ok(res, 201, "Quotation draft created", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminListQuotationsController = async (req, res) => {
  try {
    const quotations = await getAdminQuotations({ query: req.query });
    return ok(res, 200, "Quotations", quotations);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminGetQuotationController = async (req, res) => {
  try {
    const quotation = await getAdminQuotationById(req.params.id);
    return ok(res, 200, "Quotation", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminUpdateQuotationController = async (req, res) => {
  try {
    // Drafts are editable in place; sent/prepared quotations are immutable and
    // must be changed via reviseQuotation (which creates a new version).
    const quotation = await updateQuotationDraft({ adminId: req.user.userId, quotationId: req.params.id, body: req.body });
    return ok(res, 200, "Quotation draft updated", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminSendQuotationController = async (req, res) => {
  try {
    const quotation = await sendQuotation({ adminId: req.user.userId, quotationId: req.params.id });
    return ok(res, 200, "Quotation sent", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminResendQuotationController = async (req, res) => {
  try {
    const quotation = await resendQuotation({ adminId: req.user.userId, quotationId: req.params.id });
    return ok(res, 200, "Quotation resent", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminReviseQuotationController = async (req, res) => {
  try {
    const quotation = await reviseQuotation({ adminId: req.user.userId, quotationId: req.params.id, body: req.body });
    return ok(res, 201, "Quotation revised (draft)", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminDeleteQuotationController = async (req, res) => {
  try {
    const quotation = await Quotation.findById(req.params.id);
    if (!quotation) return fail(res, 404, "Quotation not found");
    if (["accepted", "converted"].includes(quotation.status)) {
      return fail(res, 409, "Cannot delete an accepted or converted quotation", { code: "QUOTATION_DELETE_BLOCKED" });
    }
    await Quotation.findByIdAndDelete(req.params.id);
    return ok(res, 200, "Quotation deleted", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminUpdatePaymentStatusController = async (req, res) => {
  try {
    const { paymentStatus } = req.body || {};
    const quotation = await updateQuotationPaymentStatus({ quotationId: req.params.id, paymentStatus });
    return ok(res, 200, "Quotation payment status updated", quotation);
  } catch (err) {
    return failErr(res, err);
  }
};
