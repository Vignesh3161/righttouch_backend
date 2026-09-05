import mongoose from "mongoose";

const { Schema } = mongoose;

const AddressSnapshotSchema = new Schema(
  {
    addressLine: String,
    city: String,
    state: String,
    pincode: String,
    name: String,
    phone: String,
    latitude: Number,
    longitude: Number,
  },
  { _id: false }
);

// Shared sub-shapes so a multi-product quotation can carry a per-item
// financial snapshot identical in structure to the single-product one.
const FinancialSnapshotSchema = new Schema(
  {
    currency: { type: String, default: "INR" },
    unitPricePaise: { type: Number, min: 0 },
    baseAmountPaise: { type: Number, min: 0 },
    installationAmountPaise: { type: Number, min: 0, default: 0 },
    additionalChargesPaise: { type: Number, min: 0, default: 0 },
    discountPaise: { type: Number, min: 0, default: 0 },
    taxableAmountPaise: { type: Number, min: 0 },
    gstPercent: { type: Number, min: 0, max: 100 },
    gstAmountPaise: { type: Number, min: 0 },
    totalAmountPaise: { type: Number, min: 0 },
    calculationVersion: { type: Number },
  },
  { _id: false }
);

const ProductSnapshotSchema = new Schema(
  {
    productName: String,
    productType: String,
    description: String,
    imageUrls: [String],
    specifications: Schema.Types.Mixed,
    warrantyPeriod: String,
  },
  { _id: false }
);

// One line in a multi-product quotation (architecture §14/§15).
const QuotationItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productSnapshot: ProductSnapshotSchema,
    quantity: { type: Number, min: 1, required: true },
    financialSnapshot: FinancialSnapshotSchema,
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
    },
  },
  { _id: true }
);

const QuotationSchema = new Schema(
  {
    quotationNumber: { type: String, required: true, unique: true },
    quoteRequestId: { type: Schema.Types.ObjectId, ref: "ProductQuoteRequest", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },

    // Multi-product support (§14/§15). When present, each item becomes its own
    // ProductBooking on acceptance. Absent => legacy single-product quotation.
    items: { type: [QuotationItemSchema], default: undefined },
    paymentGroupId: { type: Schema.Types.ObjectId, ref: "PaymentGroup" },

    revision: { type: Number, required: true },
    supersedesQuotationId: { type: Schema.Types.ObjectId, ref: "Quotation" },
    previousQuotationId: { type: Schema.Types.ObjectId, ref: "Quotation" },
    supersededAt: Date,
    supersededBy: { type: Schema.Types.ObjectId, ref: "User" },

    customerSnapshot: {
      name: String,
      phone: String,
      email: String,
      address: AddressSnapshotSchema,
    },
    productSnapshot: {
      productName: String,
      productType: String,
      description: String,
      imageUrls: [String],
      specifications: Schema.Types.Mixed,
      warrantyPeriod: String,
    },

    quantity: { type: Number, min: 1, required: true },

    // 🔒 Authoritative, server-calculated money. The customer never supplies or
    // modifies any of these fields. Immutable once status leaves `draft`.
    financialSnapshot: {
      currency: { type: String, default: "INR" },
      unitPricePaise: { type: Number, min: 0, required: true },
      baseAmountPaise: { type: Number, min: 0, required: true },
      installationAmountPaise: { type: Number, min: 0, default: 0 },
      additionalChargesPaise: { type: Number, min: 0, default: 0 },
      discountPaise: { type: Number, min: 0, default: 0 },
      taxableAmountPaise: { type: Number, min: 0, required: true },
      gstPercent: { type: Number, min: 0, max: 100, required: true },
      gstAmountPaise: { type: Number, min: 0, required: true },
      totalAmountPaise: { type: Number, min: 0, required: true },
      calculationVersion: { type: Number, required: true },
    },

    termsAndConditions: { type: String, maxlength: 10000 },
    adminNotes: { type: String, maxlength: 5000 },
    technicianNotes: { type: String, maxlength: 5000 },
    notes: { type: String, maxlength: 5000 },
    validFrom: { type: Date, required: true },
    validUntil: { type: Date, required: true },

    status: {
      type: String,
      enum: ["draft", "sent", "viewed", "accepted", "rejected", "expired", "superseded", "converted"],
      default: "draft",
      index: true,
    },

    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "partial"],
      default: "unpaid",
      index: true,
    },

    // ── Notification reliability (architecture §13) ──
    // Mirrors the QuotationDelivery outbox so Admin can see the WhatsApp/in-app
    // status without joining. The worker (processQuotationDeliveries) keeps these
    // in sync with the delivery rows.
    notificationStatus: {
      type: String,
      enum: ["pending", "queued", "sent", "failed", "retrying"],
      default: "pending",
      index: true,
    },
    failedAt: Date,
    retryCount: { type: Number, default: 0 },
    lastError: String,

    sentAt: Date,
    viewedAt: Date,
    acceptedAt: Date,
    rejectedAt: Date,
    convertedAt: Date,
    rejectedReason: String,

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    version: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One revision per (request, revision) — enforced by the app via $inc.
QuotationSchema.index({ quoteRequestId: 1, revision: 1 }, { unique: true });
QuotationSchema.index({ customerId: 1, status: 1, createdAt: -1 });
QuotationSchema.index({ validUntil: 1, status: 1 });

// Exactly one ACTIVE (sent/viewed) quotation per request. If your business needs
// multiple simultaneously-valid revisions, drop this and manage an explicit
// `activeQuotationId` on the request inside a transaction instead.
QuotationSchema.index(
  { quoteRequestId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["sent", "viewed"] } } }
);

export default mongoose.models.Quotation || mongoose.model("Quotation", QuotationSchema);
