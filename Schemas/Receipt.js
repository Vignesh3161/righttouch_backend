import mongoose from "mongoose";

const { Schema } = mongoose;

// Immutable GST tax-invoice / receipt metadata. The PDF itself is stored in
// Cloudinary behind a short-lived signed URL (never a public URL — it carries
// name + address). Regeneration is idempotent on receiptNumber.
const receiptSchema = new Schema(
  {
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment", required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, required: true, index: true },
    receiptNumber: { type: String, required: true, unique: true },
    invoiceUrl: { type: String, default: null }, // signed URL (transient)
    issuedAt: { type: Date, default: Date.now },

    // Immutable snapshot mirror (NEVER recompute from catalog)
    basePaise: Number,
    gstPaise: Number,
    tipPaise: Number,
    discountPaise: Number,
    totalPaise: Number,
    supplierName: String,
    supplierGstin: String,
    customerName: String,
    customerAddress: String,
    sacCode: String,

    // Credit note support: a refund re-issues a credit note referencing the original
    creditNoteOf: { type: Schema.Types.ObjectId, ref: "Receipt", default: null },
  },
  { timestamps: true }
);

export default mongoose.models.Receipt || mongoose.model("Receipt", receiptSchema);
