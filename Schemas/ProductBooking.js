import mongoose from "mongoose";

const ProductBookingSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    // P1/P2 — authoritative money is stored in PAISE. `amount` (rupees) is kept
    // for display/legacy; `amountPaise` is the source of truth for payments.
    amountPaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    // P1 — resolved-once financial snapshot (mirrors ServiceBooking) so the
    // payment pipeline never recomputes money from the client.
    financialSnapshot: {
      baseAmountPaise: Number,
      tipAmountPaise: { type: Number, default: 0 },
      gstPercentage: Number,
      gstAmountPaise: Number,
      commissionPercentage: { type: Number, default: 0 },
      commissionAmountPaise: { type: Number, default: 0 },
      technicianAmountPaise: { type: Number, default: 0 },
      totalAmountPaise: Number,
      calculationVersion: { type: Number, default: 1 },
      computedAt: Date,
      isFree: { type: Boolean, default: false },
    },


    // 📍 LOCATION FOR DELIVERY
    locationType: {
      type: String,
      enum: ["saved", "gps"],
      required: true,
    },

    addressSnapshot: {
      addressLine: String,
      city: String,
      state: String,
      pincode: String,
      name: String,
      phone: String,
      latitude: Number,
      longitude: Number,
    },

    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        index: "2dsphere",
      },
    },

    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "refunded", "completed"],
      default: "pending",
    },

    paymentProvider: {
      type: String,
      default: null,
    },

    paymentMode: {
      type: String,
      default: null,
    },

    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
    },

    paymentOrderId: {
      type: String,
      default: null,
    },

    paymentProviderPaymentId: {
      type: String,
      default: null,
    },

    paidAmount: {
      type: Number,
      default: 0,
    },

    paidAmountPaise: {
      type: Number,
      default: 0,
    },

    paymentRequestedAt: {
      type: Date,
      default: null,
    },

    paymentRequestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    status: {
      type: String,
      enum: ["active", "completed", "cancelled"],
      default: "active",
    },

    // Quotation linkage. New quotations are single-product, so one quotation
    // creates exactly one ProductBooking. `bookingKey` is the idempotency
    // backstop for quote→order conversion (unique, sparse for legacy rows).
    quotationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quotation",
    },
    bookingKey: {
      type: String,
      trim: true,
    },
    // Retained only for legacy data. Group payments are no longer supported:
    // every ProductBooking is paid independently.
    paymentGroupId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    quoteRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductQuoteRequest",
    },
  },
  { timestamps: true }
);

// New flow: exactly one ProductBooking per quotation. The unique sparse
// bookingKey guarantees a retried acceptance cannot create a second order.
ProductBookingSchema.index({ bookingKey: 1 }, { unique: true, sparse: true });
ProductBookingSchema.index({ quotationId: 1 }, { sparse: true });

// ── Indexes (architecture §51) ──
ProductBookingSchema.index({ customerId: 1, status: 1 });
ProductBookingSchema.index({ productId: 1 });
ProductBookingSchema.index({ paymentGroupId: 1 });

export default mongoose.models.ProductBooking || mongoose.model("ProductBooking", ProductBookingSchema);
