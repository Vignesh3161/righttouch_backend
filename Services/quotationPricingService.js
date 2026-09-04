/**
 * Quotation pricing — server-side, integer-paise, immutable after sending.
 *
 * Money rule (architecture §7):
 *   base      = unitPrice * quantity
 *   taxable   = base + installation + additionalCharges - discount
 *   gst       = round(taxable * gstPercent / 100)
 *   total     = taxable + gst
 *
 * The admin supplies the commercial inputs; the server computes GST and total
 * and asserts the invariant. The customer never submits monetary fields.
 */
import { toPaise, percentageOf, assertSplit, roundPaise } from "../Utils/money.js";

export const QUOTATION_CALCULATION_VERSION = 2;

const clean = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

export const calculateQuotationTotals = ({
  unitPricePaise,
  quantity = 1,
  installationAmountPaise = 0,
  additionalChargesPaise = 0,
  discountPaise = 0,
  gstPercent = 0,
}) => {
  const qty = Math.max(Math.floor(Number(quantity) || 1), 1);
  const unit = clean(unitPricePaise);
  const installation = clean(installationAmountPaise);
  const additional = clean(additionalChargesPaise);
  const discount = clean(discountPaise);
  const gst = Math.min(Math.max(Number(gstPercent) || 0, 0), 100);

  const baseAmountPaise = unit * qty;
  const taxablePaise = baseAmountPaise + installation + additional - discount;
  if (taxablePaise < 0) {
    const err = new Error("Taxable amount is negative (discount exceeds base + charges)");
    err.statusCode = 400;
    throw err;
  }
  const gstAmountPaise = roundPaise((taxablePaise * gst) / 100);
  const totalAmountPaise = taxablePaise + gstAmountPaise;

  return {
    financialSnapshot: {
      currency: "INR",
      unitPricePaise: unit,
      baseAmountPaise,
      installationAmountPaise: installation,
      additionalChargesPaise: additional,
      discountPaise: discount,
      taxableAmountPaise: taxablePaise,
      gstPercent: gst,
      gstAmountPaise,
      totalAmountPaise,
      calculationVersion: QUOTATION_CALCULATION_VERSION,
    },
    totalAmountPaise,
  };
};

/** Recompute and assert the stored snapshot matches the arithmetic. */
export const validateQuotationTotals = (financialSnapshot) => {
  if (!financialSnapshot) {
    const err = new Error("Missing financialSnapshot");
    err.statusCode = 400;
    throw err;
  }
  const {
    unitPricePaise,
    baseAmountPaise,
    installationAmountPaise = 0,
    additionalChargesPaise = 0,
    discountPaise = 0,
    taxableAmountPaise,
    gstPercent,
    gstAmountPaise,
    totalAmountPaise,
  } = financialSnapshot;

  const taxablePaise =
    clean(baseAmountPaise) +
    clean(installationAmountPaise) +
    clean(additionalChargesPaise) -
    clean(discountPaise);

  if (clean(taxableAmountPaise) !== taxablePaise) {
    const err = new Error("Quotation total is inconsistent");
    err.statusCode = 409;
    throw err;
  }

  const expectedGst = roundPaise((taxablePaise * (Number(gstPercent) || 0)) / 100);
  const expectedTotal = taxablePaise + expectedGst;

  if (expectedGst !== clean(gstAmountPaise) || expectedTotal !== clean(totalAmountPaise)) {
    const err = new Error("Quotation total is inconsistent");
    err.statusCode = 409;
    throw err;
  }
  return true;
};

/** Map a Quotation financial snapshot → ProductBooking financial snapshot. */
export const convertQuotationSnapshot = (quotation) => {
  const fs = quotation.financialSnapshot;
  return {
    baseAmountPaise: fs.baseAmountPaise,
    tipAmountPaise: 0,
    gstPercentage: fs.gstPercent,
    gstAmountPaise: fs.gstAmountPaise,
    commissionPercentage: 0,
    commissionAmountPaise: 0,
    technicianAmountPaise: 0,
    totalAmountPaise: fs.totalAmountPaise,
    calculationVersion: fs.calculationVersion,
    computedAt: new Date(),
    isFree: fs.totalAmountPaise === 0,
  };
};
