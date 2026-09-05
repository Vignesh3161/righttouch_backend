import { createQuoteRequest, updateQuoteRequest, getCustomerRequests, getCustomerRequestById, cancelQuoteRequest, getAdminRequests, getAdminRequestById, assignRequest, updateRequestStatus } from "../Services/productQuoteRequestService.js";
import ProductQuoteRequest from "../Schemas/ProductQuoteRequest.js";

const ok = (res, code, message, result) => res.status(code).json({ success: true, message, result: result || {} });
const fail = (res, code, message, result) => res.status(code).json({ success: false, message, result: result || {} });
const failErr = (res, err) => fail(res, err.statusCode || 500, err.message, err.code ? { code: err.code } : {});

/* ----------------------------- Customer ----------------------------- */

export const createQuoteRequestController = async (req, res) => {
  try {
    const request = await createQuoteRequest({ customerId: req.user.userId, body: req.body });
    return ok(res, 201, "Quote request created", request);
  } catch (err) {
    return failErr(res, err);
  }
};

export const listMyQuoteRequestsController = async (req, res) => {
  try {
    const requests = await getCustomerRequests({ customerId: req.user.userId, query: req.query });
    return ok(res, 200, "Quote requests", requests);
  } catch (err) {
    return failErr(res, err);
  }
};

export const getMyQuoteRequestController = async (req, res) => {
  try {
    const request = await getCustomerRequestById({ customerId: req.user.userId, id: req.params.id });
    return ok(res, 200, "Quote request", request);
  } catch (err) {
    return failErr(res, err);
  }
};

export const cancelMyQuoteRequestController = async (req, res) => {
  try {
    const request = await cancelQuoteRequest({ customerId: req.user.userId, id: req.params.id });
    return ok(res, 200, "Quote request cancelled", request);
  } catch (err) {
    return failErr(res, err);
  }
};

export const updateMyQuoteRequestController = async (req, res) => {
  try {
    const request = await updateQuoteRequest({ customerId: req.user.userId, id: req.params.id, body: req.body });
    return ok(res, 200, "Quote request updated", request);
  } catch (err) {
    return failErr(res, err);
  }
};

/* ----------------------------- Admin ----------------------------- */

export const adminListQuoteRequestsController = async (req, res) => {
  try {
    const requests = await getAdminRequests({ query: req.query });
    return ok(res, 200, "Quote requests", requests);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminGetQuoteRequestController = async (req, res) => {
  try {
    const request = await getAdminRequestById(req.params.id);
    return ok(res, 200, "Quote request", request);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminAssignQuoteRequestController = async (req, res) => {
  try {
    const request = await assignRequest({ id: req.params.id, adminId: req.user.userId });
    return ok(res, 200, "Quote request assigned", request);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminUpdateQuoteRequestStatusController = async (req, res) => {
  try {
    const request = await updateRequestStatus({ id: req.params.id, status: req.body.status, adminId: req.user.userId });
    return ok(res, 200, "Quote request status updated", request);
  } catch (err) {
    return failErr(res, err);
  }
};

export const adminDeleteQuoteRequestController = async (req, res) => {
  try {
    const request = await ProductQuoteRequest.findById(req.params.id);
    if (!request) return fail(res, 404, "Quote request not found");
    if (["accepted", "quotation_sent", "viewed"].includes(request.status)) {
      return fail(res, 409, "Cannot delete a quote request with active or accepted quotations", { code: "QUOTE_REQUEST_DELETE_BLOCKED" });
    }
    await ProductQuoteRequest.findByIdAndDelete(req.params.id);
    return ok(res, 200, "Quote request deleted", request);
  } catch (err) {
    return failErr(res, err);
  }
};
