/**
 * Quotation service — admin draft/send/revise + customer view.
 *
 * Money is ALWAYS server-calculated (quotationPricingService). A sent quotation
 * is financially immutable; changes require a new revision. Ownership is checked
 * for every customer read (architecture §14).
 */
import mongoose from "mongoose";
import Quotation from "../Schemas/Quotation.js";
import ProductQuoteRequest from "../Schemas/ProductQuoteRequest.js";
import Product from "../Schemas/Product.js";
import { calculateQuotationTotals, validateQuotationTotals } from "./quotationPricingService.js";
import { assertQuotationTransition, assertQuoteRequestTransition, canTransitionQuoteRequest, canTransitionQuotation, ACTIVE_QUOTATION_STATES } from "../Utils/quotationStateMachine.js";
import { generateQuotationNumber } from "../Utils/quotationNumber.js";
import { enqueueDeliveries } from "./quotationDeliveryService.js";
import { writeAuditLog } from "../Utils/audit.js";

const loadRequest = async (quoteRequestId) => {
  if (!mongoose.Types.ObjectId.isValid(quoteRequestId)) {
    const err = new Error("Invalid quoteRequestId");
    err.statusCode = 400;
    throw err;
  }
  const request = await ProductQuoteRequest.findById(quoteRequestId);
  if (!request) {
    const err = new Error("Quote request not found");
    err.statusCode = 404;
    throw err;
  }
  return request;
};

const snapshotProduct = async (productId) => {
  const product = await Product.findById(productId).lean();
  if (!product) return {};
  return {
    productName: product.productName,
    productType: product.productType,
    description: product.description,
    imageUrls: product.productImages || [],
    specifications: product.technicalSpecifications || {},
    warrantyPeriod: product.warrantyPeriod,
  };
};

const resolveUnitPaise = (source = {}, fallback = 0) => {
  if (source.unitPricePaise != null) return Math.round(Number(source.unitPricePaise));
  if (source.unitPrice != null) return Math.round(Number(source.unitPrice) * 100);
  if (source.price != null) return Math.round(Number(source.price) * 100);
  if (source.amount != null) return Math.round(Number(source.amount) * 100);
  if (source.finalAmount != null) return Math.round(Number(source.finalAmount) * 100);
  return fallback;
};

const resolveInstallationPaise = (source = {}, fallback = 0) => {
  if (source.installationAmountPaise != null) return Math.round(Number(source.installationAmountPaise));
  if (source.installationAmount != null) return Math.round(Number(source.installationAmount) * 100);
  if (source.installationCharges != null) return Math.round(Number(source.installationCharges) * 100);
  return fallback;
};

const resolveAdditionalPaise = (source = {}, fallback = 0) => {
  if (source.additionalChargesPaise != null) return Math.round(Number(source.additionalChargesPaise));
  if (source.additionalCharges != null) return Math.round(Number(source.additionalCharges) * 100);
  return fallback;
};

const resolveDiscountPaise = (source = {}, fallback = 0) => {
  if (source.discountPaise != null) return Math.round(Number(source.discountPaise));
  if (source.discount != null) return Math.round(Number(source.discount) * 100);
  return fallback;
};

const resolveGstPercent = (source = {}, fallback = 0) => {
  if (source.gstPercent != null) return Number(source.gstPercent);
  if (source.gstPercentage != null) return Number(source.gstPercentage);
  return fallback;
};

export const createQuotationDraft = async ({ adminId, body = {} }) => {
  const { quoteRequestId } = body;
  const request = await loadRequest(quoteRequestId);
  if (!["quote_requested", "under_review", "quotation_prepared"].includes(request.status)) {
    const err = new Error(`Cannot prepare a quotation for a request in '${request.status}' state`);
    err.statusCode = 409;
    throw err;
  }

  const topUnitPaise = resolveUnitPaise(body, 0);
  const topQuantity = body.quantity || request.quantity || 1;
  const topInstPaise = resolveInstallationPaise(body, 0);
  const topAddPaise = resolveAdditionalPaise(body, 0);
  const topDiscPaise = resolveDiscountPaise(body, 0);
  const topGst = resolveGstPercent(body, 0);

  const { financialSnapshot, totalAmountPaise } = calculateQuotationTotals({
    unitPricePaise: topUnitPaise,
    quantity: topQuantity,
    installationAmountPaise: topInstPaise,
    additionalChargesPaise: topAddPaise,
    discountPaise: topDiscPaise,
    gstPercent: topGst,
  });
  validateQuotationTotals(financialSnapshot);

  // Multi-product support (architecture §14/§15). When the admin supplies an
  // `items` array, build a per-item financial snapshot for each and derive the
  // quotation's top-level total as their sum. Legacy single-product drafts skip
  // this and use the top-level financialSnapshot computed above.
  let quotationItems = undefined;
  let topFinancialSnapshot = financialSnapshot;
  if (Array.isArray(body.items) && body.items.length > 0) {
    quotationItems = [];
    let aggBase = 0, aggGst = 0, aggTotal = 0, aggInst = 0, aggAdd = 0, aggDisc = 0;
    for (const it of body.items) {
      const itUnit = resolveUnitPaise(it, topUnitPaise);
      const itQty = it.quantity || 1;
      const itInst = resolveInstallationPaise(it, 0);
      const itAdd = resolveAdditionalPaise(it, 0);
      const itDisc = resolveDiscountPaise(it, 0);
      const itGst = resolveGstPercent(it, topGst);

      const itemTotals = calculateQuotationTotals({
        unitPricePaise: itUnit,
        quantity: itQty,
        installationAmountPaise: itInst,
        additionalChargesPaise: itAdd,
        discountPaise: itDisc,
        gstPercent: itGst,
      });
      validateQuotationTotals(itemTotals.financialSnapshot);
      const snap = await snapshotProduct(it.productId);
      quotationItems.push({
        productId: it.productId,
        productSnapshot: snap,
        quantity: itQty,
        financialSnapshot: itemTotals.financialSnapshot,
        status: "pending",
      });
      aggBase += itemTotals.financialSnapshot.baseAmountPaise || 0;
      aggInst += itemTotals.financialSnapshot.installationAmountPaise || 0;
      aggAdd += itemTotals.financialSnapshot.additionalChargesPaise || 0;
      aggDisc += itemTotals.financialSnapshot.discountPaise || 0;
      aggGst += itemTotals.financialSnapshot.gstAmountPaise || 0;
      aggTotal += itemTotals.financialSnapshot.totalAmountPaise || 0;
    }
    topFinancialSnapshot = {
      currency: "INR",
      unitPricePaise: quotationItems.length === 1 ? quotationItems[0].financialSnapshot.unitPricePaise : topUnitPaise,
      baseAmountPaise: aggBase,
      installationAmountPaise: aggInst,
      additionalChargesPaise: aggAdd,
      discountPaise: aggDisc,
      taxableAmountPaise: aggBase + aggInst + aggAdd - aggDisc,
      gstPercent: topGst,
      gstAmountPaise: aggGst,
      totalAmountPaise: aggTotal,
      calculationVersion: financialSnapshot.calculationVersion,
    };
    validateQuotationTotals(topFinancialSnapshot);
  }

  const revision = (await Quotation.countDocuments({ quoteRequestId })) + 1;
  const productSnap = await snapshotProduct(request.productId);

  const validFrom = body.validFrom ? new Date(body.validFrom) : new Date();
  const validUntil = body.validUntil ? new Date(body.validUntil) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const quotation = await Quotation.create({
    quotationNumber: generateQuotationNumber(),
    quoteRequestId: request._id,
    customerId: request.customerId,
    productId: quotationItems?.[0]?.productId || request.productId,
    items: quotationItems,
    revision,
    customerSnapshot: {
      ...request.customerSnapshot,
      address: request.addressSnapshot,
    },
    productSnapshot: { ...productSnap, productName: request.productSnapshot?.productName, productType: request.productSnapshot?.productType },
    quantity: body.quantity || request.quantity,
    financialSnapshot: topFinancialSnapshot,
    termsAndConditions: body.termsAndConditions?.toString().slice(0, 10000),
    adminNotes: (body.adminNotes || body.technicianNotes || body.notes || body.message || "")?.toString().slice(0, 5000),
    technicianNotes: (body.technicianNotes || body.adminNotes || body.notes || body.message || "")?.toString().slice(0, 5000),
    notes: (body.notes || body.message || body.adminNotes || body.technicianNotes || "")?.toString().slice(0, 5000),
    validFrom,
    validUntil,
    status: "draft",
    createdBy: adminId,
  });

  // Advance the request to "quotation_prepared" when coming from an earlier state.
  if (request.status !== "quotation_prepared") {
    assertQuoteRequestTransition(request.status, "quotation_prepared");
    request.status = "quotation_prepared";
    request.version = (request.version || 0) + 1;
    await request.save();
  }

  await writeAuditLog({
    actor: adminId,
    actorRole: "admin",
    action: "QUOTATION_DRAFT_CREATED",
    targetType: "Quotation",
    targetId: quotation._id,
    after: { quotationNumber: quotation.quotationNumber, totalAmountPaise, requestId: quoteRequestId },
  });

  return quotation;
};

/** Edit a DRAFT quotation in place (architecture §11). Sent/prepared quotations
 *  are immutable — admins must use reviseQuotation for those. Money is always
 *  re-calculated server-side from the provided inputs. */
export const updateQuotationDraft = async ({ adminId, quotationId, body = {} }) => {
  const quotation = await Quotation.findById(quotationId);
  if (!quotation) {
    const err = new Error("Quotation not found");
    err.statusCode = 404;
    err.code = "QUOTATION_NOT_FOUND";
    throw err;
  }
  if (quotation.status !== "draft") {
    const err = new Error("Sent quotations are immutable; use revise to change.");
    err.statusCode = 409;
    err.code = "QUOTATION_IMMUTABLE";
    throw err;
  }

  const existingFs = quotation.financialSnapshot || {};
  const topUnitPaise = resolveUnitPaise(body, existingFs.unitPricePaise || 0);
  const topQuantity = body.quantity ?? quotation.quantity;
  const topInstPaise = resolveInstallationPaise(body, existingFs.installationAmountPaise || 0);
  const topAddPaise = resolveAdditionalPaise(body, existingFs.additionalChargesPaise || 0);
  const topDiscPaise = resolveDiscountPaise(body, existingFs.discountPaise || 0);
  const topGst = resolveGstPercent(body, existingFs.gstPercent || 0);

  const { financialSnapshot, totalAmountPaise } = calculateQuotationTotals({
    unitPricePaise: topUnitPaise,
    quantity: topQuantity,
    installationAmountPaise: topInstPaise,
    additionalChargesPaise: topAddPaise,
    discountPaise: topDiscPaise,
    gstPercent: topGst,
  });
  validateQuotationTotals(financialSnapshot);

  let topFinancialSnapshot = financialSnapshot;
  if (Array.isArray(body.items) && body.items.length > 0) {
    const updatedItems = [];
    let aggBase = 0, aggGst = 0, aggTotal = 0, aggInst = 0, aggAdd = 0, aggDisc = 0;
    for (const it of body.items) {
      const itUnit = resolveUnitPaise(it, topUnitPaise);
      const itQty = it.quantity || 1;
      const itInst = resolveInstallationPaise(it, 0);
      const itAdd = resolveAdditionalPaise(it, 0);
      const itDisc = resolveDiscountPaise(it, 0);
      const itGst = resolveGstPercent(it, topGst);

      const itemTotals = calculateQuotationTotals({
        unitPricePaise: itUnit,
        quantity: itQty,
        installationAmountPaise: itInst,
        additionalChargesPaise: itAdd,
        discountPaise: itDisc,
        gstPercent: itGst,
      });
      validateQuotationTotals(itemTotals.financialSnapshot);
      const snap = await snapshotProduct(it.productId);
      updatedItems.push({
        productId: it.productId,
        productSnapshot: snap,
        quantity: itQty,
        financialSnapshot: itemTotals.financialSnapshot,
        status: it.status || "pending",
      });
      aggBase += itemTotals.financialSnapshot.baseAmountPaise || 0;
      aggInst += itemTotals.financialSnapshot.installationAmountPaise || 0;
      aggAdd += itemTotals.financialSnapshot.additionalChargesPaise || 0;
      aggDisc += itemTotals.financialSnapshot.discountPaise || 0;
      aggGst += itemTotals.financialSnapshot.gstAmountPaise || 0;
      aggTotal += itemTotals.financialSnapshot.totalAmountPaise || 0;
    }
    topFinancialSnapshot = {
      currency: "INR",
      unitPricePaise: updatedItems.length === 1 ? updatedItems[0].financialSnapshot.unitPricePaise : topUnitPaise,
      baseAmountPaise: aggBase,
      installationAmountPaise: aggInst,
      additionalChargesPaise: aggAdd,
      discountPaise: aggDisc,
      taxableAmountPaise: aggBase + aggInst + aggAdd - aggDisc,
      gstPercent: topGst,
      gstAmountPaise: aggGst,
      totalAmountPaise: aggTotal,
      calculationVersion: financialSnapshot.calculationVersion,
    };
    validateQuotationTotals(topFinancialSnapshot);
    quotation.items = updatedItems;
  }

  const before = {
    unitPricePaise: quotation.financialSnapshot.unitPricePaise,
    totalAmountPaise: quotation.financialSnapshot.totalAmountPaise,
  };

  quotation.financialSnapshot = topFinancialSnapshot;
  quotation.quantity = body.quantity ?? quotation.quantity;
  quotation.termsAndConditions = body.termsAndConditions?.toString().slice(0, 10000) ?? quotation.termsAndConditions;
  if (body.adminNotes !== undefined || body.notes !== undefined || body.message !== undefined || body.technicianNotes !== undefined) {
    const noteVal = (body.adminNotes || body.technicianNotes || body.notes || body.message || "").toString().slice(0, 5000);
    quotation.adminNotes = noteVal;
    quotation.technicianNotes = noteVal;
    quotation.notes = noteVal;
  }
  quotation.validFrom = body.validFrom ? new Date(body.validFrom) : quotation.validFrom;
  quotation.validUntil = body.validUntil ? new Date(body.validUntil) : quotation.validUntil;
  quotation.updatedBy = adminId;
  quotation.version = (quotation.version || 0) + 1;
  await quotation.save();

  await writeAuditLog({
    actor: adminId,
    actorRole: "admin",
    action: "QUOTATION_UPDATED",
    targetType: "Quotation",
    targetId: quotation._id,
    before,
    after: { totalAmountPaise, revision: quotation.revision },
  });

  return quotation;
};

/**
 * Send a draft. Supersedes any currently-active (sent/viewed) quotation for the
 * same request so the partial unique index permits this one to become active.
 */
export const sendQuotation = async ({ adminId, quotationId }) => {
  const quotation = await Quotation.findById(quotationId);
  if (!quotation) {
    const err = new Error("Quotation not found");
    err.statusCode = 404;
    throw err;
  }
  if (quotation.status !== "draft") {
    const err = new Error(`Only a draft can be sent (current: ${quotation.status})`);
    err.statusCode = 409;
    throw err;
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Supersede any other active quotation for this request.
      await Quotation.updateMany(
        { quoteRequestId: quotation.quoteRequestId, status: { $in: ACTIVE_QUOTATION_STATES }, _id: { $ne: quotation._id } },
        { $set: { status: "superseded", supersededAt: new Date(), supersededBy: adminId }, $inc: { version: 1 } },
        { session }
      );

      quotation.status = "sent";
      quotation.sentAt = new Date();
      quotation.notificationStatus = "queued";
      quotation.updatedBy = adminId;
      quotation.version = (quotation.version || 0) + 1;
      await quotation.save({ session });

      const request = await ProductQuoteRequest.findById(quotation.quoteRequestId).session(session);
      if (request && request.status !== "quotation_sent" && canTransitionQuoteRequest(request.status, "quotation_sent")) {
        request.status = "quotation_sent";
        request.version = (request.version || 0) + 1;
        await request.save({ session });
      }

      await enqueueDeliveries({
        quotationId: quotation._id,
        customerId: quotation.customerId,
        requestId: quotation.quoteRequestId,
        notificationType: "QUOTATION_SENT",
        title: "Your quotation ready",
        body: `Quotation ${quotation.quotationNumber} for ₹${(quotation.financialSnapshot.totalAmountPaise / 100).toFixed(2)} is ready.`,
        session,
      });
    });
  } finally {
    await session.endSession();
  }

  await writeAuditLog({
    actor: adminId,
    actorRole: "admin",
    action: "QUOTATION_SENT",
    targetType: "Quotation",
    targetId: quotation._id,
    before: { status: "draft" },
    after: { status: "sent" },
    metadata: { requestId: quotation.quoteRequestId },
  });

  return quotation;
};

export const resendQuotation = async ({ adminId, quotationId }) => {
  const quotation = await Quotation.findById(quotationId);
  if (!quotation) {
    const err = new Error("Quotation not found");
    err.statusCode = 404;
    throw err;
  }
  if (quotation.status === "draft") return sendQuotation({ adminId, quotationId });
  if (!ACTIVE_QUOTATION_STATES.includes(quotation.status)) {
    const err = new Error(`Cannot resend a quotation in '${quotation.status}' state`);
    err.statusCode = 409;
    throw err;
  }
  await enqueueDeliveries({
    quotationId: quotation._id,
    customerId: quotation.customerId,
    requestId: quotation.quoteRequestId,
    notificationType: "QUOTATION_SENT",
    title: "Your quotation is ready",
    body: `Quotation ${quotation.quotationNumber} for ₹${(quotation.financialSnapshot.totalAmountPaise / 100).toFixed(2)} is ready.`,
  });
  return quotation;
};

export const reviseQuotation = async ({ adminId, quotationId, body = {} }) => {
  const existing = await Quotation.findById(quotationId);
  if (!existing) {
    const err = new Error("Quotation not found");
    err.statusCode = 404;
    throw err;
  }
  if (["accepted", "converted"].includes(existing.status)) {
    const err = new Error(`Cannot revise an accepted or converted quotation (status: ${existing.status}). Accepted quotations are immutable.`);
    err.statusCode = 409;
    err.code = "QUOTATION_ACCEPTED_IMMUTABLE";
    throw err;
  }
  if (!["draft", "sent", "viewed", "expired", "quotation_sent", ...ACTIVE_QUOTATION_STATES].includes(existing.status)) {
    const err = new Error(`Cannot revise a quotation in '${existing.status}' state`);
    err.statusCode = 409;
    throw err;
  }

  const existingFs = existing.financialSnapshot || {};
  const topUnitPaise = resolveUnitPaise(body, existingFs.unitPricePaise || 0);
  const topQuantity = body.quantity || existing.quantity || 1;
  const topInstPaise = resolveInstallationPaise(body, existingFs.installationAmountPaise || 0);
  const topAddPaise = resolveAdditionalPaise(body, existingFs.additionalChargesPaise || 0);
  const topDiscPaise = resolveDiscountPaise(body, existingFs.discountPaise || 0);
  const topGst = resolveGstPercent(body, existingFs.gstPercent || 0);

  const { financialSnapshot, totalAmountPaise } = calculateQuotationTotals({
    unitPricePaise: topUnitPaise,
    quantity: topQuantity,
    installationAmountPaise: topInstPaise,
    additionalChargesPaise: topAddPaise,
    discountPaise: topDiscPaise,
    gstPercent: topGst,
  });
  validateQuotationTotals(financialSnapshot);

  let quotationItems = undefined;
  let topFinancialSnapshot = financialSnapshot;
  const itemsSource = Array.isArray(body.items) && body.items.length > 0 ? body.items : existing.items;
  if (Array.isArray(itemsSource) && itemsSource.length > 0) {
    quotationItems = [];
    let aggBase = 0, aggGst = 0, aggTotal = 0, aggInst = 0, aggAdd = 0, aggDisc = 0;
    for (const it of itemsSource) {
      const itUnit = resolveUnitPaise(it, topUnitPaise);
      const itQty = it.quantity || 1;
      const itInst = resolveInstallationPaise(it, 0);
      const itAdd = resolveAdditionalPaise(it, 0);
      const itDisc = resolveDiscountPaise(it, 0);
      const itGst = resolveGstPercent(it, topGst);

      const itemTotals = calculateQuotationTotals({
        unitPricePaise: itUnit,
        quantity: itQty,
        installationAmountPaise: itInst,
        additionalChargesPaise: itAdd,
        discountPaise: itDisc,
        gstPercent: itGst,
      });
      validateQuotationTotals(itemTotals.financialSnapshot);
      const snap = await snapshotProduct(it.productId);
      quotationItems.push({
        productId: it.productId,
        productSnapshot: snap,
        quantity: itQty,
        financialSnapshot: itemTotals.financialSnapshot,
        status: "pending",
      });
      aggBase += itemTotals.financialSnapshot.baseAmountPaise || 0;
      aggInst += itemTotals.financialSnapshot.installationAmountPaise || 0;
      aggAdd += itemTotals.financialSnapshot.additionalChargesPaise || 0;
      aggDisc += itemTotals.financialSnapshot.discountPaise || 0;
      aggGst += itemTotals.financialSnapshot.gstAmountPaise || 0;
      aggTotal += itemTotals.financialSnapshot.totalAmountPaise || 0;
    }
    topFinancialSnapshot = {
      currency: "INR",
      unitPricePaise: quotationItems.length === 1 ? quotationItems[0].financialSnapshot.unitPricePaise : topUnitPaise,
      baseAmountPaise: aggBase,
      installationAmountPaise: aggInst,
      additionalChargesPaise: aggAdd,
      discountPaise: aggDisc,
      taxableAmountPaise: aggBase + aggInst + aggAdd - aggDisc,
      gstPercent: topGst,
      gstAmountPaise: aggGst,
      totalAmountPaise: aggTotal,
      calculationVersion: financialSnapshot.calculationVersion,
    };
    validateQuotationTotals(topFinancialSnapshot);
  }

  const revision = existing.revision + 1;
  const quotation = await Quotation.create({
    quotationNumber: generateQuotationNumber(),
    quoteRequestId: existing.quoteRequestId,
    customerId: existing.customerId,
    productId: quotationItems?.[0]?.productId || existing.productId,
    items: quotationItems,
    revision,
    supersedesQuotationId: existing._id,
    previousQuotationId: existing._id,
    customerSnapshot: existing.customerSnapshot,
    productSnapshot: existing.productSnapshot,
    quantity: body.quantity || existing.quantity,
    financialSnapshot: topFinancialSnapshot,
    termsAndConditions: body.termsAndConditions ?? existing.termsAndConditions,
    validFrom: body.validFrom ? new Date(body.validFrom) : existing.validFrom,
    validUntil: body.validUntil ? new Date(body.validUntil) : existing.validUntil,
    status: "draft",
    createdBy: adminId,
  });

  // Mark the previous quotation as superseded so it can no longer be
  // accepted (acceptance only allows sent/viewed) and the lineage is clear.
  await Quotation.updateOne(
    { _id: existing._id },
    { $set: { supersededAt: new Date(), supersededBy: quotation._id } }
  );

  await writeAuditLog({
    actor: adminId,
    actorRole: "admin",
    action: "QUOTATION_REVISED",
    targetType: "Quotation",
    targetId: quotation._id,
    after: { supersedes: existing._id, revision, totalAmountPaise },
  });
  return quotation;
};

export const viewQuotation = async ({ customerId, id }) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid quotation id");
    err.statusCode = 400;
    throw err;
  }
  const quotation = await Quotation.findOneAndUpdate(
    { _id: id, customerId, status: "sent" },
    { $set: { status: "viewed", viewedAt: new Date() }, $inc: { version: 1 } },
    { new: true }
  );
  // Already viewed (or not found/sent) — return current doc without error.
  const result =
    quotation ||
    (await Quotation.findOne({ _id: id, customerId }).populate("productId", "productName productType productImages"));
  if (!result) {
    const err = new Error("Quotation not found");
    err.statusCode = 404;
    throw err;
  }
  return result;
};

export const getCustomerQuotations = async ({ customerId, query = {} }) => {
  const filter = { customerId };
  if (query.status) filter.status = query.status;
  return Quotation.find(filter).sort({ createdAt: -1 }).populate("productId", "productName productType productImages");
};

export const getCustomerQuotationById = async ({ customerId, id }) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid quotation id");
    err.statusCode = 400;
    throw err;
  }
  const quotation = await Quotation.findOne({ _id: id, customerId })
    .populate("productId", "productName productType productImages")
    .populate("quoteRequestId");
  if (!quotation) {
    const err = new Error("Quotation not found");
    err.statusCode = 404;
    throw err;
  }
  return quotation;
};

export const getAdminQuotations = async ({ query = {} }) => {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.quoteRequestId && mongoose.Types.ObjectId.isValid(query.quoteRequestId)) filter.quoteRequestId = query.quoteRequestId;
  return Quotation.find(filter).sort({ createdAt: -1 }).populate("productId", "productName").populate("customerId", "fname lname mobileNumber");
};

export const getAdminQuotationById = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid quotation id");
    err.statusCode = 400;
    throw err;
  }
  const quotation = await Quotation.findById(id)
    .populate("productId", "productName productType productImages")
    .populate("customerId", "fname lname mobileNumber email")
    .populate("quoteRequestId");
  if (!quotation) {
    const err = new Error("Quotation not found");
    err.statusCode = 404;
    throw err;
  }
  return quotation;
};

export const getActiveQuotationForRequest = async (quoteRequestId) =>
  Quotation.findOne({ quoteRequestId, status: { $in: ACTIVE_QUOTATION_STATES } }).sort({ revision: -1 });

/**
 * Scheduled expiry (architecture §16). The accept endpoint also enforces
 * validUntil, so this is defense-in-depth, not a security boundary.
 */
export const expireQuotations = async () => {
  const now = new Date();
  // Find active quotations that just expired, so we can also expire their request.
  const expired = await Quotation.find(
    { status: { $in: ACTIVE_QUOTATION_STATES }, validUntil: { $lte: now } },
    "quoteRequestId"
  ).lean();

  const result = await Quotation.updateMany(
    { status: { $in: ACTIVE_QUOTATION_STATES }, validUntil: { $lte: now } },
    { $set: { status: "expired" }, $inc: { version: 1 } }
  );

  // Mirror the expiry onto the associated quote request (defense-in-depth; the
  // accept endpoint also enforces validUntil).
  const requestIds = [...new Set(expired.map((q) => q.quoteRequestId).filter(Boolean))];
  if (requestIds.length) {
    await ProductQuoteRequest.updateMany(
      { _id: { $in: requestIds }, status: { $in: ["quotation_sent", "viewed"] } },
      { $set: { status: "expired" }, $inc: { version: 1 } }
    );
  }

  if (result.modifiedCount > 0) {
    console.log(`[Quotation] expired ${result.modifiedCount} quotation(s)`);
  }
  return result.modifiedCount;
};

export const updateQuotationPaymentStatus = async ({ quotationId, paymentStatus }) => {
  const quotation = await Quotation.findById(quotationId);
  if (!quotation) {
    const err = new Error("Quotation not found");
    err.statusCode = 404;
    throw err;
  }
  quotation.paymentStatus = paymentStatus || "unpaid";
  await quotation.save();
  return quotation;
};
