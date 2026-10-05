import mongoose from "mongoose";

const creditNoteSchema = new mongoose.Schema(
  {
    refundId: { type: mongoose.Schema.Types.ObjectId, ref: "Refund", required: true, unique: true },
    invoiceId: { type: String, default: null },
    creditNoteNumber: { type: String, required: true, unique: true },
    taxableValuePaise: { type: Number, default: 0, min: 0 },
    cgstPaise: { type: Number, default: 0, min: 0 },
    sgstPaise: { type: Number, default: 0, min: 0 },
    totalPaise: { type: Number, default: 0, min: 0 },
    issuedAt: { type: Date, default: null },
    gstReturnPeriod: { type: String, default: null },
    declared: { type: Boolean, default: false },
    deadline: { type: Date, default: null },
  },
  { timestamps: true }
);

creditNoteSchema.index({ declared: 1, deadline: 1 });

export default mongoose.models.CreditNote || mongoose.model("CreditNote", creditNoteSchema);
