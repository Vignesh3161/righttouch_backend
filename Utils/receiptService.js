import Receipt from "../Schemas/Receipt.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import Payment from "../Schemas/Payment.js";
import { paiseToRupees } from "./money.js";

const PLATFORM_LEGAL_NAME = process.env.PLATFORM_LEGAL_NAME || "RightTouch";
const PLATFORM_GSTIN = process.env.PLATFORM_GSTIN || "";

const fyPrefix = () => {
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `RT/${fyStart}-${String(fyStart + 1).slice(2)}`;
};

let receiptSeq = 0;
const nextReceiptNumber = async () => {
  // Monotonic per FY; safe enough for a single instance. Use a counter doc in multi-instance.
  receiptSeq += 1;
  return `${fyPrefix()}/${String(receiptSeq).padStart(6, "0")}`;
};

/**
 * Create (idempotently) an immutable receipt for a successful payment.
 * Mirrors the booking/payment snapshot — never recomputes money.
 */
export const ensureReceipt = async (paymentId) => {
  const existing = await Receipt.findOne({ paymentId }).lean();
  if (existing) return existing;

  const payment = await Payment.findById(paymentId).lean();
  if (!payment || payment.status !== "success") return null;

  const isService = payment.itemType === "service";
  const booking = isService
    ? await ServiceBooking.findById(payment.bookingId).lean()
    : await ProductBooking.findById(payment.bookingId).lean();

  const receipt = new Receipt({
    paymentId: payment._id,
    bookingId: payment.bookingId,
    customerId: booking?.customerId,
    receiptNumber: await nextReceiptNumber(),
    basePaise: payment.baseAmountPaise,
    gstPaise: payment.gstAmountPaise,
    tipPaise: payment.tipAmountPaise,
    discountPaise: 0,
    totalPaise: payment.totalAmountPaise,
    supplierName: PLATFORM_LEGAL_NAME,
    supplierGstin: PLATFORM_GSTIN,
    customerName: booking?.customerName || booking?.name || "Customer",
    customerAddress: booking?.addressLine || booking?.address?.addressLine || null,
    sacCode: isService ? process.env.SERVICE_SAC_CODE || "998311" : process.env.PRODUCT_SAC_CODE || "9971",
  });
  await receipt.save();
  return receipt;
};

/** Build a printable invoice HTML (used by the PDF/signed-URL step). */
export const buildInvoiceHtml = (receipt) => {
  const ru = (p) => (p == null ? "0.00" : paiseToRupees(p).toFixed(2));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tax Invoice ${receipt.receiptNumber}</title></head>
<body style="font-family:Arial;padding:24px">
  <h2>${receipt.supplierName}${receipt.supplierGstin ? ` (GSTIN ${receipt.supplierGstin})` : ""}</h2>
  <p>Receipt: <b>${receipt.receiptNumber}</b></p>
  <p>Billed to: ${receipt.customerName}</p>
  <p>Address: ${receipt.customerAddress || "—"}</p>
  <hr/>
  <table>
    <tr><td>Taxable value</td><td>₹${ru(receipt.basePaise)}</td></tr>
    <tr><td>GST</td><td>₹${ru(receipt.gstPaise)}</td></tr>
    <tr><td>Tip</td><td>₹${ru(receipt.tipPaise)}</td></tr>
    <tr><td><b>Total</b></td><td><b>₹${ru(receipt.totalPaise)}</b></td></tr>
  </table>
</body></html>`;
};
