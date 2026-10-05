import mongoose from "mongoose";

/**
 * 🏦 PLATFORM CASH LEDGER — the single source of truth for the platform's
 * financial position. Admin cash is derived from THIS ledger, never by summing
 * Payment documents.
 *
 * Every entry is append-only, immutable, and idempotent via a unique
 * idempotencyKey (e.g. "payment:<paymentId>:customer-payment"). Replays of the
 * same event are no-ops.
 *
 * Entry types:
 *   customer_payment          credit — gross customer money collected
 *   technician_earning_liability — liability allocation (money owed to techs)
 *   platform_commission       credit — platform revenue (commission)
 *   customer_refund           debit  — money returned to customer
 *   gateway_fee / gateway_fee_tax — payment gateway costs
 *   technician_payout         debit  — actual RazorpayX payout executed
 *   payout_fee / payout_fee_tax   — RazorpayX payout costs
 *   cancellation_fee          credit — collected cancellation fee (if collected)
 *   chargeback                debit  — chargeback / reversal
 *   manual_adjustment         +/-    — explicit, audited corrections
 */
const platformLedgerEntrySchema = new mongoose.Schema(
  {
    entryId: {
      type: String,
      unique: true,
      default: () => new mongoose.Types.ObjectId().toString(),
    },

    type: {
      type: String,
      enum: [
        "customer_payment",
        "customer_refund",
        "gateway_fee",
        "gateway_fee_tax",
        "technician_earning_liability",
        "technician_payout",
        "payout_fee",
        "payout_fee_tax",
        "platform_commission",
        "cancellation_fee",
        "chargeback",
        "manual_adjustment",
        "mdr_loss",
        "refund_processing_fee",
        "gst_credit_note",
        "commission_reversal",
        "technician_clawback",
        "uncollected_clawback",
      ],
      required: true,
      index: true,
    },

    direction: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },

    amountPaise: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      default: "INR",
    },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      default: null,
      index: true,
    },

    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
      index: true,
    },

    withdrawalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WithdrawalRequest",
      default: null,
      index: true,
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      default: null,
      index: true,
    },

    providerReference: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: ["posted", "pending", "reconciled", "exception"],
      default: "posted",
      index: true,
    },

    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
    },

    description: {
      type: String,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

platformLedgerEntrySchema.index({ type: 1, createdAt: 1 });
platformLedgerEntrySchema.index({ bookingId: 1, type: 1 });

export default mongoose.models.PlatformLedgerEntry ||
  mongoose.model("PlatformLedgerEntry", platformLedgerEntrySchema);