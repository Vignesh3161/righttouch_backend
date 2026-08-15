import mongoose from "mongoose";

const walletTransactionSchema = new mongoose.Schema(
  {
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "TechnicianProfile" },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceBooking" },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
    withdrawalId: { type: mongoose.Schema.Types.ObjectId, ref: "WithdrawalRequest", default: null },
    // Integer paise
    amountPaise: { type: Number, required: true, min: 0 },
    // Legacy rupee mirror (migration window)
    amount: { type: Number, default: null },
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },
    source: {
      type: String,
      enum: ["job", "tip", "withdraw", "adjustment", "bonus", "penalty", "refund"],
      required: true,
    },
    // Global idempotency key — "job:<bookingId>", "withdrawal:<withdrawalId>",
    // "withdrawal-refund:<withdrawalId>", "penalty:<bookingId>" ...
    idempotencyKey: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
    },
    note: { type: String, trim: true },
    reason: { type: String, trim: true },
  },
  { timestamps: true }
);

// Find ledger entries linked to a withdrawal (reserve debit / refund credit)
walletTransactionSchema.index({ withdrawalId: 1, type: 1 });

// ✅ One job-credit per booking (prevents double-credit)
walletTransactionSchema.index(
  { bookingId: 1, type: 1, source: 1 },
  {
    unique: true,
    partialFilterExpression: {
      bookingId: { $exists: true, $ne: null },
      type: "credit",
      source: "job",
    },
  }
);

// P0: wallet ledger lookups — technician transaction lists + earnings summaries
walletTransactionSchema.index({ technicianId: 1, type: 1, source: 1 });
walletTransactionSchema.index({ technicianId: 1, createdAt: -1 });

export default mongoose.models.WalletTransaction || mongoose.model("WalletTransaction", walletTransactionSchema);