/**
 * Product pay-in money helper (P1/P2/P3).
 *
 * All product money is resolved ONCE, server-side, from the catalog and the
 * validated client quote. The result is stored in PAISE only — `amount`
 * (rupees) on ProductBooking is display-only and is never the basis for a
 * Razorpay order. This closes the rupee/paise unit bug and removes any client
 * ability to influence the captured amount.
 */

export const buildProductFinancialSnapshot = ({ amountRupees, quantity = 1, gstPercent = 0 }) => {
  const qty = Math.max(Math.floor(Number(quantity) || 1), 1);
  const baseRupees = Math.max(Number(amountRupees) || 0, 0);
  const baseAmountPaise = Math.round(baseRupees * 100) * qty;
  const gstAmountPaise = Math.round((baseAmountPaise * (Number(gstPercent) || 0)) / 100);
  const totalAmountPaise = baseAmountPaise + gstAmountPaise;

  return {
    // authoritative total the customer must pay (paise)
    amountPaise: totalAmountPaise,
    financialSnapshot: {
      baseAmountPaise,
      tipAmountPaise: 0,
      gstPercentage: Number(gstPercent) || 0,
      gstAmountPaise,
      commissionPercentage: 0,
      commissionAmountPaise: 0,
      technicianAmountPaise: 0,
      totalAmountPaise,
      calculationVersion: 2,
      computedAt: new Date(),
      isFree: totalAmountPaise === 0,
    },
  };
};

/**
 * P3 — validate the client-quoted amount against the catalog's estimated
 * price band. `after_inspection` products skip the bound check (price is
 * determined on site).
 */
export const validateProductAmountAgainstCatalog = ({ amountRupees, product }) => {
  if (!product) return { ok: false, reason: "Product not found" };
  if (product.pricingModel === "after_inspection") return { ok: true };

  const from = product.estimatedPriceFrom;
  const to = product.estimatedPriceTo;
  if (from != null && amountRupees < from) {
    return { ok: false, reason: `Amount ₹${amountRupees} is below the catalog estimate (from ₹${from})` };
  }
  if (to != null && amountRupees > to) {
    return { ok: false, reason: `Amount ₹${amountRupees} exceeds the catalog estimate (up to ₹${to})` };
  }
  return { ok: true };
};
