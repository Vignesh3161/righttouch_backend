import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import ReserveHold from "../Schemas/ReserveHold.js";
import { atomicWalletDebit } from "./walletDebit.js";

const key = (refundId, step) => `rfd:${refundId}:${step}`;

export const applyClawback = async ({ technicianId, refundId, amountPaise, session = null }) => {
  const opts = session ? { session } : {};

  // Cascade A — consume the ReserveHold for THIS technician if present.
  const targetHold = await ReserveHold.findOne(
    { technicianId, status: { $in: ["held", "frozen"] } },
    null,
    opts
  );
  if (targetHold) {
    targetHold.status = "consumed";
    targetHold.consumedBy = refundId;
    await targetHold.save(opts);
  }

  // Cascade B/C/D — atomic, clamped, CAS-guarded debit (no read-then-write race,
  // balance can never go negative). Ledger rows are idempotent per step.
  const result = await atomicWalletDebit({
    technicianId,
    amountPaise,
    reason: "Clawback",
    idempotencyKey: key(refundId, "clawback"),
    session,
  });

  return { appliedReserve: result.reserve, appliedAvailable: result.available, toDues: result.dues };
};

export const reverseClawback = async ({ technicianId, refundId, session = null }) => {
  const opts = session ? { session } : {};
  const base = key(refundId, "clawback");
  const entries = await WalletTransaction.find(
    {
      technicianId,
      idempotencyKey: { $in: [`${base}:reserve`, `${base}:available`, `${base}:dues`] },
    },
    null,
    opts
  ).lean();

  for (const e of entries) {
    const step = e.idempotencyKey.split(":").pop();
    if (step === "dues") {
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        { $inc: { outstandingDuesPaise: -e.amountPaise, walletVersion: 1 } },
        opts
      );
    } else {
      // reserve & available rows are credited back to availableBalancePaise
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        { $inc: { availableBalancePaise: e.amountPaise, walletVersion: 1 } },
        opts
      );
    }
    await WalletTransaction.deleteOne({ _id: e._id }, opts);
  }

  await ReserveHold.updateMany(
    { consumedBy: refundId },
    { $set: { status: "held", consumedBy: null, releaseAt: new Date() } },
    opts
  );
};
