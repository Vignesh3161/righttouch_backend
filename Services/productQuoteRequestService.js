/**
 * ProductQuoteRequest service — customer requirement capture + admin workflow.
 *
 * Owns: request lifecycle, snapshots, assignment. Must NOT own order/payment
 * state (architecture §3). Customer ownership is enforced in every query.
 */
import mongoose from "mongoose";
import Product from "../Schemas/Product.js";
import User from "../Schemas/User.js";
import Address from "../Schemas/Address.js";
import ProductQuoteRequest from "../Schemas/ProductQuoteRequest.js";
import { generateRequestNumber } from "../Utils/quotationNumber.js";
import { assertQuoteRequestTransition } from "../Utils/quotationStateMachine.js";
import { writeAuditLog } from "../Utils/audit.js";
import { broadcastAdminUnreadCounts } from "../Controllers/adminNotificationController.js";
import { getIo } from "../Utils/ioAccess.js";

const newRequestNumber = async () => {
  // Retry a few times in the astronomically-unlikely event of a collision.
  for (let i = 0; i < 5; i += 1) {
    const requestNumber = generateRequestNumber();
    const exists = await ProductQuoteRequest.exists({ requestNumber });
    if (!exists) return requestNumber;
  }
  throw new Error("Unable to allocate a unique request number");
};

const resolveAddress = async ({ customerId, addressId, locationType, latitude, longitude }) => {
  if (locationType === "saved") {
    if (!addressId || !mongoose.Types.ObjectId.isValid(addressId)) {
      const err = new Error("addressId is required for saved location");
      err.statusCode = 400;
      throw err;
    }
    const addr = await Address.findOne({ _id: addressId, customerId }).lean();
    if (!addr) {
      const err = new Error("Address not found");
      err.statusCode = 404;
      throw err;
    }
    return {
      addressSnapshot: {
        addressLine: addr.addressLine,
        city: addr.city,
        state: addr.state,
        pincode: addr.pincode,
        name: addr.name,
        phone: addr.phone,
        latitude: addr.latitude,
        longitude: addr.longitude,
      },
      location: addr.latitude != null && addr.longitude != null
        ? { type: "Point", coordinates: [addr.longitude, addr.latitude] }
        : undefined,
    };
  }
  // gps
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const err = new Error("latitude and longitude are required for gps location");
    err.statusCode = 400;
    throw err;
  }
  return {
    addressSnapshot: { latitude: lat, longitude: lng },
    location: { type: "Point", coordinates: [lng, lat] },
  };
};

export const createQuoteRequest = async ({ customerId, body = {} }) => {
  const {
    productId,
    quantity,
    locationType,
    addressId,
    latitude,
    longitude,
    requirementDescription,
    additionalNotes,
    preferredContactMethod,
  } = body;

  if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
    const err = new Error("Valid productId is required");
    err.statusCode = 400;
    throw err;
  }
  const qty = Math.floor(Number(quantity));
  if (!Number.isInteger(qty) || qty < 1) {
    const err = new Error("quantity must be an integer >= 1");
    err.statusCode = 400;
    throw err;
  }
  if (locationType !== "saved" && locationType !== "gps") {
    const err = new Error("locationType must be 'saved' or 'gps'");
    err.statusCode = 400;
    throw err;
  }

  const product = await Product.findById(productId).lean();
  if (!product || !product.isActive) {
    const err = new Error("Product not found or inactive");
    err.statusCode = 404;
    throw err;
  }

  const [customer, address] = await Promise.all([
    User.findById(customerId).select("fname lname mobileNumber email").lean(),
    resolveAddress({ customerId, addressId, locationType, latitude, longitude }),
  ]);
  if (!customer) {
    const err = new Error("Customer not found");
    err.statusCode = 404;
    throw err;
  }

  // Idempotency: Return existing open request thread for this customer + product if present
  const existingActive = await ProductQuoteRequest.findOne({
    customerId,
    productId,
    status: { $in: ["quote_requested", "under_review", "quotation_prepared", "quotation_sent", "viewed", "expired", "rejected"] },
  });
  if (existingActive) {
    if (["expired", "rejected"].includes(existingActive.status)) {
      existingActive.status = "under_review";
      existingActive.version = (existingActive.version || 0) + 1;
      await existingActive.save();
    }
    return existingActive;
  }

  const requestNumber = await newRequestNumber();
  const request = await ProductQuoteRequest.create({
    requestNumber,
    customerId,
    productId,
    customerSnapshot: {
      name: [customer.fname, customer.lname].filter(Boolean).join(" ").trim(),
      phone: customer.mobileNumber,
      email: customer.email,
    },
    productSnapshot: {
      productName: product.productName,
      productType: product.productType,
      imageUrl: product.productImages?.[0] || null,
    },
    quantity: qty,
    locationType,
    addressSnapshot: address.addressSnapshot,
    location: address.location,
    requirementDescription: requirementDescription?.toString().slice(0, 5000),
    additionalNotes: additionalNotes?.toString().slice(0, 2000),
    preferredContactMethod: preferredContactMethod || "whatsapp",
    status: "quote_requested",
  });

  await writeAuditLog({
    actor: customerId,
    actorRole: "customer",
    action: "QUOTE_REQUEST_CREATED",
    targetType: "ProductQuoteRequest",
    targetId: request._id,
    after: { requestNumber, productId, status: "quote_requested" },
  });

  // Broadcast real-time admin unread notification badge update
  broadcastAdminUnreadCounts(getIo());

  return request;
};

export const updateQuoteRequest = async ({ customerId, id, body = {} }) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid request id");
    err.statusCode = 400;
    throw err;
  }

  const request = await ProductQuoteRequest.findOne({ _id: id, customerId });
  if (!request) {
    const err = new Error("Quote request not found");
    err.statusCode = 404;
    throw err;
  }

  if (["accepted", "cancelled"].includes(request.status)) {
    const err = new Error(`Cannot update a request in '${request.status}' state`);
    err.statusCode = 409;
    err.code = "QUOTE_REQUEST_LOCKED";
    throw err;
  }

  const changedFields = [];
  const oldValues = {};
  const newValues = {};

  if (body.quantity !== undefined) {
    const qty = Math.floor(Number(body.quantity));
    if (!Number.isInteger(qty) || qty < 1) {
      const err = new Error("quantity must be an integer >= 1");
      err.statusCode = 400;
      throw err;
    }
    if (request.quantity !== qty) {
      changedFields.push("quantity");
      oldValues.quantity = request.quantity;
      newValues.quantity = qty;
      request.quantity = qty;
    }
  }

  if (body.requirementDescription !== undefined) {
    const val = body.requirementDescription?.toString().slice(0, 5000) || "";
    if (request.requirementDescription !== val) {
      changedFields.push("requirementDescription");
      oldValues.requirementDescription = request.requirementDescription;
      newValues.requirementDescription = val;
      request.requirementDescription = val;
    }
  }

  if (body.additionalNotes !== undefined) {
    const val = body.additionalNotes?.toString().slice(0, 2000) || "";
    if (request.additionalNotes !== val) {
      changedFields.push("additionalNotes");
      oldValues.additionalNotes = request.additionalNotes;
      newValues.additionalNotes = val;
      request.additionalNotes = val;
    }
  }

  if (body.preferredContactMethod !== undefined) {
    const val = body.preferredContactMethod || "whatsapp";
    if (request.preferredContactMethod !== val) {
      changedFields.push("preferredContactMethod");
      oldValues.preferredContactMethod = request.preferredContactMethod;
      newValues.preferredContactMethod = val;
      request.preferredContactMethod = val;
    }
  }

  if (body.locationType !== undefined || body.addressId !== undefined || body.latitude !== undefined || body.longitude !== undefined) {
    const locType = body.locationType || request.locationType;
    const resolved = await resolveAddress({
      customerId,
      addressId: body.addressId,
      locationType: locType,
      latitude: body.latitude,
      longitude: body.longitude,
    });
    changedFields.push("addressSnapshot", "location");
    oldValues.addressSnapshot = request.addressSnapshot;
    newValues.addressSnapshot = resolved.addressSnapshot;
    request.locationType = locType;
    request.addressSnapshot = resolved.addressSnapshot;
    request.location = resolved.location;
  }

  if (changedFields.length === 0) {
    return request;
  }

  request.version = (request.version || 0) + 1;
  request.requestHistory.push({
    version: request.version,
    changedFields,
    oldValues,
    newValues,
    changedAt: new Date(),
    changedBy: customerId,
  });

  // If there are existing active quotations sent/viewed for this request, mark them as superseded
  // and revert request status to under_review so admin creates a fresh revision matching the new specs.
  const Quotation = (await import("../Schemas/Quotation.js")).default;
  const activeQuotes = await Quotation.find({
    quoteRequestId: request._id,
    status: { $in: ["sent", "viewed"] },
  });

  if (activeQuotes.length > 0) {
    await Quotation.updateMany(
      { quoteRequestId: request._id, status: { $in: ["sent", "viewed"] } },
      { $set: { status: "superseded", supersededAt: new Date() }, $inc: { version: 1 } }
    );
    request.status = "under_review";
  }

  await request.save();

  await writeAuditLog({
    actor: customerId,
    actorRole: "customer",
    action: "QUOTE_REQUEST_UPDATED",
    targetType: "ProductQuoteRequest",
    targetId: request._id,
    before: oldValues,
    after: newValues,
    metadata: { changedFields },
  });

  return request;
};

export const getCustomerRequests = async ({ customerId, query = {} }) => {
  const filter = { customerId };
  if (query.status) filter.status = query.status;
  return ProductQuoteRequest.find(filter).sort({ createdAt: -1 }).populate("productId", "productName productType productImages");
};

export const getCustomerRequestById = async ({ customerId, id }) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid request id");
    err.statusCode = 400;
    throw err;
  }
  const request = await ProductQuoteRequest.findOne({ _id: id, customerId })
    .populate("productId", "productName productType productImages")
    .populate("acceptedQuotationId");
  if (!request) {
    const err = new Error("Quote request not found");
    err.statusCode = 404;
    throw err;
  }
  return request;
};

export const cancelQuoteRequest = async ({ customerId, id }) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid request id");
    err.statusCode = 400;
    throw err;
  }
  const request = await ProductQuoteRequest.findOne({ _id: id, customerId });
  if (!request) {
    const err = new Error("Quote request not found");
    err.statusCode = 404;
    throw err;
  }
  if (!["quote_requested", "under_review"].includes(request.status)) {
    const err = new Error(`Cannot cancel a request in '${request.status}' state`);
    err.statusCode = 409;
    throw err;
  }
  assertQuoteRequestTransition(request.status, "cancelled");
  request.status = "cancelled";
  request.version = (request.version || 0) + 1;
  await request.save();

  await writeAuditLog({
    actor: customerId,
    actorRole: "customer",
    action: "QUOTE_REQUEST_CANCELLED",
    targetType: "ProductQuoteRequest",
    targetId: request._id,
    before: { status: "quote_requested" },
    after: { status: "cancelled" },
  });
  return request;
};

/* ----------------------------- Admin side ----------------------------- */

export const getAdminRequests = async ({ query = {} }) => {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.productId && mongoose.Types.ObjectId.isValid(query.productId)) filter.productId = query.productId;
  return ProductQuoteRequest.find(filter)
    .sort({ createdAt: -1 })
    .populate("productId", "productName productType productImages category estimatedPriceFrom estimatedPriceTo price brand modelNumber description")
    .populate("customerId", "fname lname mobileNumber email address city streetAddress pincode");
};

export const getAdminRequestById = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid request id");
    err.statusCode = 400;
    throw err;
  }
  const request = await ProductQuoteRequest.findById(id)
    .populate("productId", "productName productType productImages productGst estimatedPriceFrom estimatedPriceTo")
    .populate("customerId", "fname lname mobileNumber email");
  if (!request) {
    const err = new Error("Quote request not found");
    err.statusCode = 404;
    throw err;
  }
  return request;
};

export const assignRequest = async ({ id, adminId }) => {
  const request = await ProductQuoteRequest.findById(id);
  if (!request) {
    const err = new Error("Quote request not found");
    err.statusCode = 404;
    err.code = "QUOTE_REQUEST_NOT_FOUND";
    throw err;
  }
  // Terminal or already-in-progress states cannot be (re)assigned.
  if (["quotation_prepared", "quotation_sent", "viewed", "accepted", "rejected", "cancelled", "expired"].includes(request.status)) {
    const err = new Error(`Cannot assign a request in '${request.status}' state`);
    err.statusCode = 409;
    err.code = "QUOTE_REQUEST_ASSIGN_CONFLICT";
    throw err;
  }

  const previousAdminId = request.assignedAdminId;
  const isReassign = request.status === "under_review";

  // Idempotent: re-assigning to the SAME admin is a no-op (no version bump).
  if (isReassign && String(previousAdminId) === String(adminId)) {
    return request;
  }

  request.assignedAdminId = adminId;
  request.assignedAt = new Date();
  if (request.status === "quote_requested") {
    request.status = "under_review";
  }
  request.version = (request.version || 0) + 1;
  await request.save();

  await writeAuditLog({
    actor: adminId,
    actorRole: "admin",
    action: "QUOTE_REQUEST_ASSIGNED",
    targetType: "ProductQuoteRequest",
    targetId: request._id,
    before: isReassign ? { assignedAdminId: previousAdminId, status: "under_review" } : { status: "quote_requested" },
    after: { assignedAdminId: adminId, status: request.status, assignedAt: request.assignedAt },
    metadata: isReassign ? { reassignedFrom: previousAdminId } : undefined,
  });
  return request;
};

export const updateRequestStatus = async ({ id, status, adminId }) => {
  const request = await ProductQuoteRequest.findById(id);
  if (!request) {
    const err = new Error("Quote request not found");
    err.statusCode = 404;
    throw err;
  }
  assertQuoteRequestTransition(request.status, status);
  const before = request.status;
  request.status = status;
  request.version = (request.version || 0) + 1;
  await request.save();

  await writeAuditLog({
    actor: adminId,
    actorRole: "admin",
    action: "QUOTE_REQUEST_STATUS_CHANGED",
    targetType: "ProductQuoteRequest",
    targetId: request._id,
    before: { status: before },
    after: { status },
  });
  return request;
};
