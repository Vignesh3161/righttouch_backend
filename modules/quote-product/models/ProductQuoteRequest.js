import mongoose from "mongoose";

const { Schema } = mongoose;

// Shared sub-shapes (kept local so this collection is self-describing).
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

const GeoPointSchema = new Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], index: "2dsphere" }, // [longitude, latitude]
  },
  { _id: false }
);

const ProductQuoteRequestSchema = new Schema(
  {
    requestNumber: { type: String, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },

    // Multi-product request support (architecture §14). When present, each entry
    // is a distinct product the customer wants quoted. Absent => legacy
    // single-product request (productId above is authoritative).
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
        quantity: { type: Number, min: 1, default: 1 },
      },
    ],

    // Frozen customer + product context at request time (audit/display only;
    // the authenticated customer remains authoritative for ownership).
    customerSnapshot: {
      name: String,
      phone: String,
      email: String,
    },
    productSnapshot: {
      productName: String,
      productType: String,
      imageUrl: String,
    },

    quantity: { type: Number, min: 1, required: true },
    locationType: { type: String, enum: ["saved", "gps"], required: true },
    addressSnapshot: AddressSnapshotSchema,
    location: GeoPointSchema,

    requirementDescription: { type: String, maxlength: 5000 },
    additionalNotes: { type: String, maxlength: 2000 },
    preferredContactMethod: {
      type: String,
      enum: ["whatsapp", "call", "both"],
      default: "whatsapp",
    },

    status: {
      type: String,
      enum: [
        "quote_requested",
        "under_review",
        "quotation_prepared",
        "quotation_sent",
        "viewed",
        "accepted",
        "rejected",
        "cancelled",
        "expired",
      ],
      default: "quote_requested",
      index: true,
    },

    assignedAdminId: { type: Schema.Types.ObjectId, ref: "User" },
    assignedAt: Date,
    version: { type: Number, default: 0 },
    acceptedQuotationId: { type: Schema.Types.ObjectId, ref: "Quotation" },

    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    readBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    requestHistory: [
      {
        version: { type: Number },
        changedFields: [String],
        oldValues: Schema.Types.Mixed,
        newValues: Schema.Types.Mixed,
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: Schema.Types.ObjectId, ref: "User" },
      },
    ],
  },
  { timestamps: true }
);

ProductQuoteRequestSchema.index({ customerId: 1, createdAt: -1 });
ProductQuoteRequestSchema.index({ status: 1, createdAt: -1 });
ProductQuoteRequestSchema.index({ isRead: 1, status: 1 });

// Ensure at most ONE active/ongoing quote request thread exists per (customerId, productId).
// Accepted or cancelled requests are inactive/terminal and do not block new requests.
ProductQuoteRequestSchema.index(
  { customerId: 1, productId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [
          "quote_requested",
          "under_review",
          "quotation_prepared",
          "quotation_sent",
          "viewed",
          "expired",
          "rejected",
        ],
      },
    },
  }
);

export default mongoose.models.ProductQuoteRequest ||
  mongoose.model("ProductQuoteRequest", ProductQuoteRequestSchema);
