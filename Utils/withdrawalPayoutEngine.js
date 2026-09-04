import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import PayoutOutbox from "../Schemas/PayoutOutbox.js";
import {
  createRazorpayContact,
  createFundAccount,
  createPayout,
} from "../Controllers/razorpayXController.js";
import { writeAuditLog } from "./audit.js";
import { hasActivePayoutBlock } from "./complaintFreeze.js";
import { safeDebitAvailable } from "./walletDebit.js";
import { fingerprintBankDetails } from "./kycPrivacy.js";
import { getDekForKycDoc, decryptBankDetails } from "./kycFieldCrypto.js";
import { toPaise, rupeesToPaise, paiseToRupees } from "./money.js";
import { postPayoutLedgerEntry } from "./ledger.js";
import { SOCKET_ROOMS, SOCKET_EVENTS } from "./socketConstants.js";
import { sendPushNotification } from "./sendNotification.js";
import Notification from "../Schemas/Notification.js";
import { getIo } from "./ioAccess.js";

/**
 * 🏦 WITHDRAWAL PAYOUT ENGINE — the ONE Razorpay X payout pipeline.
 *
 * Used by BOTH the admin "pay" action and the system-initiated auto-payouts.
 * Sharing a single pipeline guarantees that every payout — manual or auto —
 * passes the same KYC gates (verified bank/UPI + fingerprint guard) and the
 * same outbox + reconciliation semantics:
 *
 *  1. [txn] Withdrawal → processing; PayoutOutbox → initiated (upsert by
 *     withdrawalId; attempts +1)
 *  2. Contact + Fund Account created/reused (cached on TechnicianProfile)
 *  3. Razorpay X POST /v1/payouts (X-Payout-Idempotency: withdrawalId)
 *  4. [txn] success → withdrawal paid, reserve release, lifetime withdrawn,
 *     platform ledger (technician_payout), outbox completed
 *     failure → withdrawal reverted to approved (retryable) / manual_review
 *     when the outcome is ambiguous (never blind-retry — double-pay risk)
 *
 * The 10-min reconciliation cron (`reconcileStuckPayouts`) is engine-agnostic:
 * it keys off PayoutOutbox.withdrawalId, so auto-payouts recover exactly like
 * manual ones.
 *
 * Errors are thrown with `.statusCode` + `.message` so the caller (HTTP
 * controller or cron) maps them to its own response/telemetry.
 */

const isAmbiguousError = (errMsg) =>
  /timeout|ETIMEDOUT|ECONNRESET|socket|network|ECONNREFUSED|EAI_AGAIN/i.test(errMsg);

// Mask a bank account number → "****1234" (last 4 only).
const maskAccountNumber = (acc) => {
  if (!acc) return null;
  const s = String(acc).replace(/\s/g, "");
  return s.length <= 4 ? "****" + s : "****" + s.slice(-4);
};

// Mask a UPI handle → "vi***@okhdfcbank" (first 2 chars + domain).
const maskUpiId = (upi) => {
  if (!upi) return null;
  const s = String(upi).trim().toLowerCase();
  if (!s.includes("@")) return "***@upi";
  const [handle, domain] = s.split("@");
  const head = handle.length <= 2 ? handle[0] || "" : handle.slice(0, 2);
  return `${head}***@${domain}`;
};

export const executeWithdrawalPayout = async ({
  withdrawalId,
  actor = null, // { userId, role } — null for system-initiated (auto) payouts
  narration = "RightTouch Technician Payout",
  adminNote = null,
  io = null, // socket.io instance — used only for auto-payout notifications
}) => {
  const session = await mongoose.startSession();
  let outboxId = null;
  let withdrawal = null;
  try {
    /* ── 1. Load withdrawal ── */
    withdrawal = await WithdrawalRequest.findById(withdrawalId);
    if (!withdrawal) {
      const err = new Error("Withdrawal request not found");
      err.statusCode = 404;
      throw err;
    }
    if (!["pending", "requested", "approved"].includes(withdrawal.status)) {
      const err = new Error(
        `Cannot pay a withdrawal with status "${withdrawal.status}"`
      );
      err.statusCode = 400;
      throw err;
    }

    // O1 — refuse to pay out while a complaint payout-block is active. The
    // retention reserve must stay frozen until the complaint is resolved.
    if (await hasActivePayoutBlock(withdrawal.technicianId)) {
      const err = new Error(
        "Payout blocked: an open complaint is holding the retention reserve. Resolve the complaint first."
      );
      err.statusCode = 409;
      throw err;
    }

    /* ── 2. Load technician profile + user (loaded here so the O2 dues check
       below can read outstandingDuesPaise without a temporal-dead-zone
       ReferenceError). ── */
    const techProfile = await TechnicianProfile.findById(
      withdrawal.technicianId
    ).populate("userId", "fname lname mobileNumber email");
    if (!techProfile) {
      const err = new Error("Technician profile not found");
      err.statusCode = 404;
      throw err;
    }

    // O2 — never pay out while the technician still owes outstanding dues
    // (unrecoverable clawback shortfall). Dues are recovered from earnings,
    // not from further payouts.
    if ((techProfile.outstandingDuesPaise || 0) > 0) {
      const err = new Error(
        `Payout blocked: technician has outstanding dues of ₹${(techProfile.outstandingDuesPaise / 100).toFixed(2)}. Recover via earnings first.`
      );
      err.statusCode = 409;
      throw err;
    }

    const user = techProfile.userId;
    const technicianKyc = await TechnicianKyc.findOne({
      technicianId: withdrawal.technicianId,
    });

    // Payouts may only use KYC-tracked bank details. The legacy
    // techProfile.bankDetails field is NOT a valid payout source —
    // it was never subject to the verification workflow.
    const dek = await getDekForKycDoc(technicianKyc);
    const bankDetails = decryptBankDetails(technicianKyc?.bankDetails, dek) || {};
    const hasBank = bankDetails.accountNumber && bankDetails.ifscCode;
    const hasUpi = !!bankDetails.upiId;

    if (!hasBank && !hasUpi) {
      const err = new Error(
        "No bank/UPI on file for technician. Update bankDetails in TechnicianKYC before paying."
      );
      err.statusCode = 422;
      throw err;
    }

    /* ── 3. KYC gate: verified bank/UPI required before payout ── */
    const bankVerified =
      technicianKyc?.bankVerified === true ||
      technicianKyc?.bankVerificationStatus === "approved";
    if (!bankVerified) {
      const err = new Error(
        "Technician bank/UPI details are not verified. Verify them before paying."
      );
      err.statusCode = 422;
      throw err;
    }

    // Fingerprint guard: verification is tied to the EXACT details that were
    // approved. If they drifted (updated outside the KYC flow, legacy records,
    // tampering), invalidate the approval and block the payout until the
    // account is re-verified by an admin.
    const currentFingerprint = fingerprintBankDetails(bankDetails);
    const storedFingerprint = technicianKyc?.bankDetailsFingerprint;
    if (!storedFingerprint || !currentFingerprint || storedFingerprint !== currentFingerprint) {
      await TechnicianKyc.updateOne(
        { technicianId: withdrawal.technicianId },
        {
          $set: {
            bankVerified: false,
            bankVerificationStatus: "pending",
            bankUpdateRequired: true,
            bankDetailsFingerprint: null,
          },
        }
      );
      const err = new Error(
        "Bank details changed since verification (or legacy record without fingerprint). Please re-verify the technician's bank details before paying."
      );
      err.statusCode = 422;
      throw err;
    }

    /* ── 4. Outbox init [txn] ── */
    let outbox;
    await session.withTransaction(async () => {
      const fresh = await WithdrawalRequest.findById(withdrawal._id).session(session);
      if (!["pending", "requested", "approved"].includes(fresh.status)) {
        const err = new Error(
          `Withdrawal is no longer payable (status: ${fresh.status})`
        );
        err.statusCode = 409;
        throw err;
      }

      fresh.status = "processing";
      fresh.decidedAt = new Date();
      fresh.decidedBy = actor?.userId ?? null;
      await fresh.save({ session });

      outbox = await PayoutOutbox.findOneAndUpdate(
        { withdrawalId: withdrawal._id },
        {
          $set: {
            idempotencyKey: String(withdrawal._id),
            status: "initiated",
            initiatedAt: new Date(),
            completedAt: null,
            failedAt: null,
            lastError: null,
          },
          $inc: { attempts: 1 },
        },
        { upsert: true, new: true, session }
      );

      fresh.payoutOutboxId = outbox._id;
      await fresh.save({ session });
      outboxId = String(outbox._id);
    });

    /* ── 5. Get or create Razorpay Contact ── */
    let contactId = techProfile.razorpayContactId;
    if (!contactId) {
      contactId = await createRazorpayContact({
        name: user ? `${user.fname || ""} ${user.lname || ""}`.trim() : "Technician",
        email: user?.email || undefined,
        contact: user?.mobileNumber || undefined,
        referenceId: String(techProfile._id),
      });
      techProfile.razorpayContactId = contactId;
      await techProfile.save();
    }

    /* ── 6. Get or create Razorpay Fund Account ── */
    let fundAccountId = techProfile.razorpayFundAccountId;
    if (!fundAccountId) {
      fundAccountId = await createFundAccount({ contactId, bankDetails });
      techProfile.razorpayFundAccountId = fundAccountId;
      await techProfile.save();
    }

    /* ── 7. Determine payout mode ── */
    const payoutMode = hasUpi ? "UPI" : "IMPS";

    // Masked destination for history (never expose the full account number).
    const payoutDestination =
      hasUpi
        ? maskUpiId(bankDetails.upiId)
        : maskAccountNumber(bankDetails.accountNumber);

    /* ── 8. Financial Breakdown Calculation & Razorpay X Payout ── */
    const totalRequestedPaise = toPaise(
      withdrawal.requestedAmountPaise ?? withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount)
    );
    const commissionDeductionPaise = toPaise(withdrawal.commissionDeductionPaise || 0);
    const penaltyDeductionPaise = toPaise(withdrawal.penaltyDeductionPaise || 0);
    const otherDeductionsPaise = toPaise(withdrawal.otherDeductionsPaise || 0);

    const netPayoutAmountPaise = Math.max(
      0,
      withdrawal.netPayoutAmountPaise ??
        (totalRequestedPaise - commissionDeductionPaise - penaltyDeductionPaise - otherDeductionsPaise)
    );

    const amountPaiseNum = netPayoutAmountPaise;

    const rzpPayout = await createPayout({
      fundAccountId,
      amountInPaisa: amountPaiseNum,
      mode: payoutMode,
      referenceId: String(withdrawal._id),
      narration,
    });

    /* ── 9. Save payout reference and set status to processing ── */
    await session.withTransaction(async () => {
      const fresh = await WithdrawalRequest.findById(withdrawal._id).session(session);
      fresh.status = "processing";
      fresh.decidedAt = new Date();
      fresh.decidedBy = actor?.userId ?? null;
      fresh.payoutProvider = "razorpay_x";
      fresh.payoutReference = rzpPayout.id;
      fresh.payoutMode = payoutMode;
      fresh.payoutDestination = payoutDestination;
      fresh.requestedAmountPaise = totalRequestedPaise;
      fresh.commissionDeductionPaise = commissionDeductionPaise;
      fresh.penaltyDeductionPaise = penaltyDeductionPaise;
      fresh.penaltyReason = withdrawal.penaltyReason || fresh.penaltyReason || null;
      fresh.otherDeductionsPaise = otherDeductionsPaise;
      fresh.netPayoutAmountPaise = netPayoutAmountPaise;
      fresh.amountPaise = netPayoutAmountPaise;
      fresh.amount = paiseToRupees(netPayoutAmountPaise);
      fresh.adminNote = adminNote || `Payout submitted via Razorpay X (${payoutMode})`;
      await fresh.save({ session });

      outbox.razorpayPayoutId = rzpPayout.id;
      outbox.payoutPayload = {
        mode: payoutMode,
        razorpayStatus: rzpPayout.status,
        initiatedBy: actor ? actor.role : "system",
      };
      await outbox.save({ session });
    });

    await writeAuditLog({
      actor: actor?.userId,
      actorRole: actor?.role || "System",
      action: "PAYOUT_SUBMITTED_TO_RAZORPAYX",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      after: {
        requestedAmountPaise: totalRequestedPaise,
        netPayoutAmountPaise,
        payoutId: rzpPayout.id,
        mode: payoutMode,
        razorpayStatus: rzpPayout.status,
        status: "processing",
      },
      reason: adminNote || null,
    });

    // If RazorpayX immediately returned terminal state, settle immediately
    if (rzpPayout.status === "processed") {
      await settlePayoutSuccess({
        withdrawalId: withdrawal._id,
        razorpayPayoutId: rzpPayout.id,
        utr: rzpPayout.utr || null,
        payoutPayload: rzpPayout,
        actor,
      });
      return {
        success: true,
        message: "Payout processed successfully",
        payoutId: rzpPayout.id,
        payoutStatus: "processed",
        mode: payoutMode,
        amount: paiseToRupees(amountPaiseNum),
        amountPaise: amountPaiseNum,
        withdrawalStatus: "paid",
        payoutDestination,
      };
    } else if (["failed", "rejected", "reversed", "cancelled"].includes(rzpPayout.status)) {
      await settlePayoutFailure({
        withdrawalId: withdrawal._id,
        razorpayPayoutId: rzpPayout.id,
        failureReason: rzpPayout.failure_reason || "Payout failed",
        payoutPayload: rzpPayout,
        actor,
      });
      return {
        success: false,
        message: rzpPayout.failure_reason || "Payout failed",
        payoutId: rzpPayout.id,
        payoutStatus: rzpPayout.status,
        mode: payoutMode,
        amount: paiseToRupees(amountPaiseNum),
        amountPaise: amountPaiseNum,
        withdrawalStatus: "failed",
        payoutDestination,
      };
    }

    return {
      success: true,
      message: "Payout initiated successfully and is processing",
      payoutId: rzpPayout.id,
      payoutStatus: rzpPayout.status,
      mode: payoutMode,
      amount: paiseToRupees(amountPaiseNum),
      amountPaise: amountPaiseNum,
      withdrawalStatus: "processing",
      payoutDestination,
    };
  } catch (error) {
    // Mark outbox + withdrawal failed so the admin/system can retry (approved).
    // IMPORTANT: the outbox stays "initiated" (NOT "failed") — if the payout
    // actually succeeded at Razorpay before the response was lost, the
    // reconciliation cron must still reconcile it (retry with the same
    // reference id also returns the original payout). A "failed" status here
    // would orphan a potentially-sent payout, risking a DOUBLE payout.
    //
    // Ambiguous outcomes (timeouts/network errors) go to MANUAL_REVIEW — we
    // never retry blindly without knowing the provider status.
    const errMsg = String(error?.message || error?.error?.description || "");
    const ambiguous = isAmbiguousError(errMsg);

    if (outboxId || withdrawal?._id) {
      const session2 = await mongoose.startSession();
      try {
        await session2.withTransaction(async () => {
          const outboxDoc = outboxId
            ? await PayoutOutbox.findById(outboxId).session(session2)
            : await PayoutOutbox.findOne({ withdrawalId: withdrawal._id }).session(session2);

          if (outboxDoc && outboxDoc.status === "initiated") {
            outboxDoc.lastError = errMsg || "Payout failed";
            outboxDoc.failedAt = new Date(); // informational; status stays initiated for reconcile
            if (ambiguous) outboxDoc.status = "manual_review";
            await outboxDoc.save({ session2 });
          }

          const w = await WithdrawalRequest.findById(withdrawal._id).session(session2);
          if (w && w.status === "processing") {
            w.status = ambiguous ? "manual_review" : "approved"; // retryable only when failure is certain
            w.decisionNote = `Payout ${ambiguous ? "outcome unknown" : "failed"}: ${errMsg || "unknown"}`;
            w.failureReason = ambiguous ? null : `Payout failed: ${errMsg || "unknown"}`;
            w.failedAt = new Date();
            await w.save({ session2 });
          }
        });

        await writeAuditLog({
          actor: actor?.userId,
          actorRole: actor?.role || "System",
          action: "PAYOUT_FAILED",
          targetType: "WithdrawalRequest",
          targetId: withdrawal._id,
          after: {
            status: ambiguous ? "manual_review" : "approved",
            error: errMsg || "unknown",
            ambiguous,
          },
          reason: ambiguous
            ? "Payout outcome unknown (timeout/network) — manual review required before retry"
            : "Payout failed; withdrawal reverted to approved for retry",
        });
      } catch (auditErr) {
        console.error("executeWithdrawalPayout revert error:", auditErr.message);
      } finally {
        await session2.endSession();
      }
    }

    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * 🔔 Payout paid — socket event + FCM push to the technician.
 * Socket first (live sessions), push as the durable channel. Fired for every
 * successful payout regardless of origin (technician auto / system auto /
 * admin manual).
 */
const notifyPayoutPaid = async ({
  io,
  technicianProfileId,
  withdrawalId,
  requestedAmountPaise,
  commissionDeductionPaise = 0,
  penaltyDeductionPaise = 0,
  penaltyReason = null,
  otherDeductionsPaise = 0,
  netPayoutAmountPaise,
  payoutReference,
  remainingBalancePaise,
}) => {
  const requested = paiseToRupees(requestedAmountPaise || netPayoutAmountPaise);
  const netPayout = paiseToRupees(netPayoutAmountPaise);
  const penalty = paiseToRupees(penaltyDeductionPaise);
  const commission = paiseToRupees(commissionDeductionPaise);
  const remainingBalance = paiseToRupees(remainingBalancePaise ?? 0);

  let title = "✅ Payout Transferred";
  let body = `₹${netPayout.toFixed(2)} has been sent to your bank/UPI account.`;

  if (penalty > 0) {
    title = "⚠️ Withdrawal Processed (Penalty Deducted)";
    body = `Requested: ₹${requested.toFixed(2)}. Penalty Deducted: ₹${penalty.toFixed(2)} (${penaltyReason || "Admin deduction"}). Net Payout Sent: ₹${netPayout.toFixed(2)}.`;
  } else if (commission > 0) {
    title = "✅ Withdrawal Processed (Fee Deducted)";
    body = `Requested: ₹${requested.toFixed(2)}. Admin Fee: ₹${commission.toFixed(2)}. Net Payout Sent: ₹${netPayout.toFixed(2)}.`;
  }

  try {
    await Notification.create({
      recipientId: technicianProfileId,
      recipientType: "technician",
      eventType: "WITHDRAWAL_PAID",
      title,
      body,
      data: {
        type: "WITHDRAWAL_PAID",
        withdrawalId: String(withdrawalId),
        requestedAmount: requested,
        commissionDeduction: commission,
        penaltyDeduction: penalty,
        penaltyReason,
        netPayoutAmount: netPayout,
        payoutReference,
      },
      category: "finance",
    });

    if (io) {
      io.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(
        SOCKET_EVENTS.AUTO_PAYOUT_PAID,
        {
          withdrawalId: String(withdrawalId),
          requestedAmount: requested,
          requestedAmountPaise,
          commissionDeduction: commission,
          commissionDeductionPaise,
          penaltyDeduction: penalty,
          penaltyDeductionPaise,
          penaltyReason,
          netPayoutAmount: netPayout,
          netPayoutAmountPaise,
          amountPaise: netPayoutAmountPaise,
          amount: netPayout,
          payoutReference,
          remainingBalancePaise,
          remainingBalance,
          timestamp: new Date().toISOString(),
        }
      );
    }

    await sendPushNotification(
      technicianProfileId,
      {
        title,
        body,
        data: {
          type: "WITHDRAWAL_PAID",
          withdrawalId: String(withdrawalId),
          amount: String(netPayout),
          amountPaise: String(netPayoutAmountPaise),
          penaltyDeduction: String(penalty),
          penaltyReason: penaltyReason || "",
        },
      },
      { recipientType: "technician" }
    );
  } catch (err) {
    console.warn(`⚠️ Withdrawal notification failed for tech ${technicianProfileId}:`, err.message);
  }
};

/**
 * 🔔 Payout failed notification to technician.
 */
export const notifyPayoutFailed = async ({
  io,
  technicianProfileId,
  withdrawalId,
  amountPaise,
  failureReason,
}) => {
  const amt = paiseToRupees(amountPaise || 0);
  const title = "❌ Payout Failed";
  const body = `Your withdrawal request for ₹${amt.toFixed(2)} could not be processed. The amount has been returned to your wallet. Reason: ${failureReason || "Transaction failed"}`;

  try {
    await Notification.create({
      recipientId: technicianProfileId,
      recipientType: "technician",
      eventType: "WITHDRAWAL_FAILED",
      title,
      body,
      data: {
        type: "WITHDRAWAL_FAILED",
        withdrawalId: String(withdrawalId),
        amount: amt,
        failureReason: failureReason || "",
      },
      category: "finance",
    });

    if (io) {
      io.to(SOCKET_ROOMS.TECHNICIAN(technicianProfileId)).emit(
        "payout-failed",
        {
          withdrawalId: String(withdrawalId),
          amount: amt,
          amountPaise,
          failureReason: failureReason || "",
          timestamp: new Date().toISOString(),
        }
      );
    }

    await sendPushNotification(
      technicianProfileId,
      {
        title,
        body,
        data: {
          type: "WITHDRAWAL_FAILED",
          withdrawalId: String(withdrawalId),
          amount: String(amt),
          failureReason: failureReason || "",
        },
      },
      { recipientType: "technician" }
    );
  } catch (err) {
    console.warn(`⚠️ Withdrawal failure notification failed for tech ${technicianProfileId}:`, err.message);
  }
};

/**
 * 🎯 Idempotent Settlement: Settle Payout as PAID (Success)
 * Executed via Webhook (payout.processed) or Reconciliation Cron.
 */
export const settlePayoutSuccess = async ({
  withdrawalId,
  razorpayPayoutId = null,
  utr = null,
  payoutPayload = null,
  actor = null,
}) => {
  const session = await mongoose.startSession();
  let remainingBalancePaise = null;
  let isNewSettlement = false;
  let withdrawal = null;

  try {
    await session.withTransaction(async () => {
      withdrawal = await WithdrawalRequest.findById(withdrawalId).session(session);
      if (!withdrawal) return;
      if (withdrawal.status === "paid") {
        return; // Idempotent
      }

      const totalRequestedPaise = toPaise(
        withdrawal.requestedAmountPaise ?? withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount)
      );
      const commissionDeductionPaise = toPaise(withdrawal.commissionDeductionPaise || 0);
      const penaltyDeductionPaise = toPaise(withdrawal.penaltyDeductionPaise || 0);
      const otherDeductionsPaise = toPaise(withdrawal.otherDeductionsPaise || 0);
      const netPayoutAmountPaise = Math.max(
        0,
        withdrawal.netPayoutAmountPaise ??
          (totalRequestedPaise - commissionDeductionPaise - penaltyDeductionPaise - otherDeductionsPaise)
      );

      withdrawal.status = "paid";
      withdrawal.paidAt = new Date();
      withdrawal.processedAt = new Date();
      if (razorpayPayoutId) withdrawal.payoutReference = razorpayPayoutId;
      if (utr) withdrawal.utr = utr;
      withdrawal.payoutProvider = "razorpay_x";
      withdrawal.failureReason = null;
      withdrawal.requestedAmountPaise = totalRequestedPaise;
      withdrawal.netPayoutAmountPaise = netPayoutAmountPaise;
      withdrawal.amountPaise = netPayoutAmountPaise;
      withdrawal.amount = paiseToRupees(netPayoutAmountPaise);
      await withdrawal.save({ session });

      // Un-reserve requested amount, increase lifetime withdrawn by net amount
      await TechnicianProfile.updateOne(
        { _id: withdrawal.technicianId },
        {
          $inc: {
            reservedBalancePaise: -totalRequestedPaise,
            lifetimeWithdrawnPaise: netPayoutAmountPaise,
          },
        },
        { session }
      );

      // Record Penalty transaction if penalty applied
      if (penaltyDeductionPaise > 0) {
        await WalletTransaction.create(
          [
            {
              technicianId: withdrawal.technicianId,
              amountPaise: penaltyDeductionPaise,
              amount: paiseToRupees(penaltyDeductionPaise),
              type: "debit",
              source: "penalty",
              withdrawalId: withdrawal._id,
              idempotencyKey: `withdrawal-penalty:${withdrawal._id}`,
              note: `Penalty deduction: ${withdrawal.penaltyReason || "Penalty applied on withdrawal"}`,
            },
          ],
          { session }
        );
      }

      // Record Commission transaction if commission applied
      if (commissionDeductionPaise > 0) {
        await WalletTransaction.create(
          [
            {
              technicianId: withdrawal.technicianId,
              amountPaise: commissionDeductionPaise,
              amount: paiseToRupees(commissionDeductionPaise),
              type: "debit",
              source: "adjustment",
              withdrawalId: withdrawal._id,
              idempotencyKey: `withdrawal-commission:${withdrawal._id}`,
              note: `Commission deduction on withdrawal #${withdrawal._id}`,
            },
          ],
          { session }
        );
      }

      // Record PlatformLedgerEntry
      const ledger = await postPayoutLedgerEntry({
        withdrawal,
        providerReference: razorpayPayoutId || withdrawal.payoutReference,
        session,
      });
      if (!ledger.created) {
        console.warn(`[PayoutEngine] ledger entry already posted for withdrawal ${withdrawal._id}`);
      }

      // Update PayoutOutbox
      await PayoutOutbox.updateOne(
        { withdrawalId: withdrawal._id },
        {
          $set: {
            status: "completed",
            razorpayPayoutId: razorpayPayoutId || withdrawal.payoutReference,
            payoutPayload: payoutPayload || undefined,
            completedAt: new Date(),
          },
        },
        { session }
      );

      const techAfter = await TechnicianProfile.findById(withdrawal.technicianId)
        .select("availableBalancePaise")
        .session(session)
        .lean();
      remainingBalancePaise = toPaise(techAfter?.availableBalancePaise ?? 0);
      isNewSettlement = true;
    });

    if (isNewSettlement && withdrawal) {
      await writeAuditLog({
        actor: actor?.userId,
        actorRole: actor?.role || "System",
        action: "PAYOUT_SETTLED_SUCCESS",
        targetType: "WithdrawalRequest",
        targetId: withdrawal._id,
        after: {
          status: "paid",
          payoutReference: razorpayPayoutId || withdrawal.payoutReference,
          utr,
        },
      });

      await notifyPayoutPaid({
        io: getIo(),
        technicianProfileId: withdrawal.technicianId,
        withdrawalId: withdrawal._id,
        requestedAmountPaise: withdrawal.requestedAmountPaise,
        commissionDeductionPaise: withdrawal.commissionDeductionPaise,
        penaltyDeductionPaise: withdrawal.penaltyDeductionPaise,
        penaltyReason: withdrawal.penaltyReason,
        otherDeductionsPaise: withdrawal.otherDeductionsPaise,
        netPayoutAmountPaise: withdrawal.netPayoutAmountPaise,
        payoutReference: razorpayPayoutId || withdrawal.payoutReference,
        remainingBalancePaise,
      });
    }

    return { success: true, status: "paid" };
  } finally {
    session.endSession();
  }
};

/**
 * 🎯 Idempotent Settlement: Settle Payout as FAILED (Reversal & Refund)
 * Executed via Webhook (payout.failed/reversed) or Reconciliation Cron.
 */
export const settlePayoutFailure = async ({
  withdrawalId,
  razorpayPayoutId = null,
  failureReason = "Payout failed",
  payoutPayload = null,
  actor = null,
}) => {
  const session = await mongoose.startSession();
  let isNewFailure = false;
  let withdrawal = null;

  try {
    await session.withTransaction(async () => {
      withdrawal = await WithdrawalRequest.findById(withdrawalId).session(session);
      if (!withdrawal) return;
      if (["paid", "failed", "cancelled"].includes(withdrawal.status)) {
        return; // Idempotent check
      }

      const totalRequestedPaise = toPaise(
        withdrawal.requestedAmountPaise ?? withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount)
      );

      withdrawal.status = "failed";
      withdrawal.failedAt = new Date();
      withdrawal.failureReason = failureReason;
      withdrawal.decisionNote = `Payout failed: ${failureReason}`;
      if (razorpayPayoutId) withdrawal.payoutReference = razorpayPayoutId;
      await withdrawal.save({ session });

      // Move reserved balance back to available balance
      await TechnicianProfile.updateOne(
        { _id: withdrawal.technicianId },
        {
          $inc: {
            availableBalancePaise: totalRequestedPaise,
            reservedBalancePaise: -totalRequestedPaise,
          },
        },
        { session }
      );

      // Create compensating refund transaction
      await WalletTransaction.create(
        [
          {
            technicianId: withdrawal.technicianId,
            amountPaise: totalRequestedPaise,
            amount: paiseToRupees(totalRequestedPaise),
            type: "credit",
            source: "adjustment",
            withdrawalId: withdrawal._id,
            idempotencyKey: `withdrawal-refund:${withdrawal._id}`,
            note: `Refund for failed withdrawal #${withdrawal._id}: ${failureReason}`,
          },
        ],
        { session }
      );

      // Update PayoutOutbox
      await PayoutOutbox.updateOne(
        { withdrawalId: withdrawal._id },
        {
          $set: {
            status: "failed",
            razorpayPayoutId: razorpayPayoutId || withdrawal.payoutReference,
            payoutPayload: payoutPayload || undefined,
            failedAt: new Date(),
            lastError: failureReason,
          },
        },
        { session }
      );

      isNewFailure = true;
    });

    if (isNewFailure && withdrawal) {
      await writeAuditLog({
        actor: actor?.userId,
        actorRole: actor?.role || "System",
        action: "PAYOUT_SETTLED_FAILURE",
        targetType: "WithdrawalRequest",
        targetId: withdrawal._id,
        after: {
          status: "failed",
          failureReason,
        },
      });

      await notifyPayoutFailed({
        io: getIo(),
        technicianProfileId: withdrawal.technicianId,
        withdrawalId: withdrawal._id,
        amountPaise: withdrawal.amountPaise,
        failureReason,
      });
    }

    return { success: true, status: "failed" };
  } finally {
    session.endSession();
  }
};

/**
 * 🔓 Release a reserve after a CERTAIN (non-ambiguous) payout failure so the
 * technician is never left with their balance frozen and can safely retry.
 *
 * Safety: the withdrawal + PayoutOutbox are both marked terminal (`failed`)
 * so the 10-min reconciliation cron (which only acts on `initiated` outboxes)
 * can never re-pay a payout that was never actually sent to Razorpay. The
 * wallet reserve (available→reserved) is moved back (reserved→available) and a
 * refund WalletTransaction is recorded for an accurate history.
 *
 * For AMBIGUOUS (timeout/network) outcomes, do NOT call this — leave the
 * withdrawal in `manual_review` with the reserve held so reconciliation can
 * decide without risking a double payout.
 */
export const releaseFailedWithdrawalReserve = async ({
  withdrawalId,
  amountPaise,
  technicianId,
  reason = null,
}) => {
  const amt = toPaise(amountPaise);
  const s = await mongoose.startSession();
  try {
    await s.withTransaction(async () => {
      const w = await WithdrawalRequest.findById(withdrawalId).session(s);
      if (!w) return;
      w.status = "failed";
      w.failedAt = new Date();
      w.decisionNote = `Payout failed: ${reason || "unknown"}`;
      w.failureReason = `Payout failed: ${reason || "unknown"}`;
      await w.save({ session: s });

      await PayoutOutbox.updateOne(
        { withdrawalId },
        { $set: { status: "failed", failedAt: new Date(), lastError: reason || "Payout failed" } },
        { session: s }
      );

      await TechnicianProfile.updateOne(
        { _id: technicianId },
        { $inc: { availableBalancePaise: amt, reservedBalancePaise: -amt } },
        { session: s }
      );

      await WalletTransaction.create(
        [
          {
            technicianId,
            amountPaise: amt,
            amount: paiseToRupees(amt),
            type: "credit",
            source: "adjustment",
            withdrawalId,
            idempotencyKey: `withdrawal-refund:${withdrawalId}`,
            note: `Refund for failed withdrawal #${withdrawalId}`,
          },
        ],
        { session: s }
      );
    });
  } catch (e) {
    console.error("releaseFailedWithdrawalReserve error:", e.message);
  } finally {
    s.endSession();
  }
};