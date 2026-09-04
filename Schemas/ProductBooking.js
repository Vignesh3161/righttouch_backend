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

    status: {
      type: String,
      enum: ["active", "completed", "cancelled"],
      default: "active",
    },

    // 🔒 Quotation linkage — a ProductBooking created from an accepted quotation
    // carries the quotation reference. A multi-product quotation produces several
    // ProductBookings that SHARE the same quotationId (and paymentGroupId), so
    // this index is intentionally NON-unique. Idempotency of quote→order
    // conversion is enforced in the acceptance service by counting bookings.
    quotationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quotation",
      index: true,
    },
    // Groups the bookings produced from one (possibly multi-product) quotation
    // so they can be paid via a single payment order.
    paymentGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentGroup",
      index: true,
    },
    quoteRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductQuoteRequest",
    },
  },
  { timestamps: true }
);

// NOTE: quotationId is no longer unique — a multi-product quotation yields
// multiple ProductBookings sharing the same quotationId. Idempotency is handled
// in the acceptance service by counting existing bookings for the quotation.
ProductBookingSchema.index({ quotationId: 1 }, { sparse: true });

// ── Indexes (architecture §51) ──
ProductBookingSchema.index({ customerId: 1, status: 1 });
ProductBookingSchema.index({ productId: 1 });
ProductBookingSchema.index({ paymentGroupId: 1 });

export default mongoose.models.ProductBooking || mongoose.model("ProductBooking", ProductBookingSchema);
