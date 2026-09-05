/**
 * Unique, human-readable numbering for quote requests and quotations.
 * The DB unique index is the real guarantee; these generators just produce
 * low-collision candidates. Callers should retry once on a duplicate-key error.
 */
import crypto from "crypto";

const pad = (n, len = 4) => String(n).padStart(len, "0");

const stamp = () => {
  // YYMMDD + 4-char random base36 — readable and collision-resistant enough
  // that duplicates are extraordinarily rare (the unique index is the backstop).
  const d = new Date();
  const ymd = `${pad(d.getFullYear() % 100, 2)}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase().slice(0, 4);
  return `${ymd}${rand}`;
};

export const generateRequestNumber = () => `QREQ-${stamp()}`;

export const generateQuotationNumber = () => `QUOT-${stamp()}`;
