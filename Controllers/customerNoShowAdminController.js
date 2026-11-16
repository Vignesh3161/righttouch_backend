import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import { postLedgerEntry } from "../Utils/ledger.js";
import { writeAuditLog } from "../Utils/audit.js";

const fail = (res, status, message, code = null) =>
  res.status(status).json({
    success: false,
    ...(code ? { code } : {}),
    message,
    result: {},
  });

const compensationKey = (bookingId) => `customer-no-show-compensation:${bookingId}`;

export const reviewCustomerNoShowCompensation = async (req, res) => {
  try {
    if (!["Admin", "Owner"].includes(req.user?.role)) {
      return fail(res, 403, "Admin/Owner access only");
    }
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "Invalid booking id");
    }
    const action = String(req.body?.action || "").trim().toLowerCase();
    if (!["approve", "reject", "mark_paid"].includes(action)) {
      return fail(res, 400, "action must be approve, reject, or mark_paid", "INVALID_ACTION");
    }

    const booking = await ServiceBooking.findById(id);
    if (!booking) return fail(res, 404, "Booking not found");
    if (booking.customerNoShowStatus !== "confirmed") {
      return fail(res, 409, "Only a confirmed customer no-show can be reviewed", "NO_SHOW_NOT_CONFIRMED");
    }

    const amountPaise = Math.max(0, Number(booking.customerNoShowCompensationPaise) || 0);
    const current = booking.customerNoShowCompensationStatus || "none";
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : null;
    const now = new Date();
    const before = {
      status: current,
      amountPaise,
      note: booking.customerNoShowReviewNote || null,
    };

    if (action === "approve") {
      if (amountPaise <= 0) {
        return fail(res, 400, "There is no compensation amount to approve", "NOTHING_TO_APPROVE");
      }
      if (current !== "recorded") {
        return fail(res, 409, "Compensation is not in a reviewable state", "INVALID_COMPENSATION_STATE");
      }
      await postLedgerEntry({
        type: "manual_adjustment",
        direction: "debit",
        amountPaise,
        idempotencyKey: compensationKey(booking._id),
        refs: { bookingId: booking._id, technicianId: booking.technicianId || null },
        status: "pending",
        description: "Customer no-show compensation approved",
        metadata: { source: "customer_no_show", approvedBy: req.user?.userId || null },
      });
      await ServiceBooking.updateOne(
        { _id: booking._id },
        {
          $set: {
            customerNoShowCompensationStatus: "approved",
            customerNoShowCompensationApprovedAt: now,
            customerNoShowCompensationApprovedBy: req.user?.userId || null,
            customerNoShowReviewNote: note,
          },
        }
      );
      booking.customerNoShowCompensationStatus = "approved";
      booking.customerNoShowCompensationApprovedAt = now;
      booking.customerNoShowCompensationApprovedBy = req.user?.userId || null;
      booking.customerNoShowReviewNote = note;
    } else if (action === "reject") {
      if (!["recorded", "approved"].includes(current)) {
        return fail(res, 409, "Compensation is not in a reviewable state", "INVALID_COMPENSATION_STATE");
      }
      await PlatformLedgerEntry.updateOne(
        { idempotencyKey: compensationKey(booking._id), status: "pending" },
        { $set: { status: "exception" } }
      );
      await ServiceBooking.updateOne(
        { _id: booking._id },
        {
          $set: {
            customerNoShowCompensationStatus: "rejected",
            customerNoShowReviewNote: note,
          },
        }
      );
      booking.customerNoShowCompensationStatus = "rejected";
      booking.customerNoShowReviewNote = note;
    } else {
      if (current !== "approved") {
        return fail(res, 409, "Compensation must be approved before it is marked paid", "INVALID_COMPENSATION_STATE");
      }
      const providerReference =
        typeof req.body?.providerReference === "string"
          ? req.body.providerReference.trim().slice(0, 200)
          : null;
      const ledgerUpdate = await PlatformLedgerEntry.updateOne(
        { idempotencyKey: compensationKey(booking._id) },
        {
          $set: {
            status: "posted",
            ...(providerReference ? { providerReference } : {}),
          },
        }
      );
      if (!ledgerUpdate.matchedCount) {
        return fail(res, 409, "Compensation liability entry is missing", "LEDGER_ENTRY_MISSING");
      }
      await ServiceBooking.updateOne(
        { _id: booking._id },
        {
          $set: {
            customerNoShowCompensationStatus: "paid",
            customerNoShowCompensationPaidAt: now,
            customerNoShowReviewNote: note || booking.customerNoShowReviewNote,
          },
        }
      );
      booking.customerNoShowCompensationStatus = "paid";
      booking.customerNoShowCompensationPaidAt = now;
      booking.customerNoShowReviewNote = note || booking.customerNoShowReviewNote;
    }

    await writeAuditLog({
      actor: req.user?.userId || null,
      actorRole: req.user?.role || null,
      action: `CUSTOMER_NO_SHOW_COMPENSATION_${action.toUpperCase()}`,
      targetType: "ServiceBooking",
      targetId: booking._id,
      before,
      after: {
        status: booking.customerNoShowCompensationStatus,
        amountPaise,
        note: booking.customerNoShowReviewNote || null,
      },
      reason: note,
    });

    return res.status(200).json({
      success: true,
      message:
        action === "approve"
          ? "Compensation approved and recorded as a pending platform liability"
          : action === "reject"
            ? "Compensation rejected"
            : "Compensation marked paid",
      result: {
        bookingId: booking._id,
        customerNoShowStatus: booking.customerNoShowStatus,
        compensationStatus: booking.customerNoShowCompensationStatus,
        compensationPaise: amountPaise,
        approvedAt: booking.customerNoShowCompensationApprovedAt,
        paidAt: booking.customerNoShowCompensationPaidAt,
        reviewNote: booking.customerNoShowReviewNote,
      },
    });
  } catch (error) {
    return fail(res, error.statusCode || 500, error.message);
  }
};
