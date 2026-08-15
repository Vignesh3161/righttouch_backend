import test from "node:test";
import assert from "node:assert/strict";

import {
  toPaise,
  rupeesToPaise,
  paiseToRupees,
  percentageOf,
  splitWithCommission,
  assertSplit,
  CALCULATION_VERSION,
} from "../Utils/money.js";
import {
  resolveCommissionSnapshot,
  getActiveCommissionRule,
  stripClientMoneyFields,
} from "../Utils/commission.js";
import { deriveSettlementSplit } from "../Utils/settlement.js";

/* =====================================================
   MONEY HELPERS — integer paise, no float drift
===================================================== */

test("rupeesToPaise and paiseToRupees round-trip without drift", () => {
  assert.equal(rupeesToPaise(499.99), 49999);
  assert.equal(paiseToRupees(49999), 499.99);
  assert.equal(paiseToRupees(rupeesToPaise(0.1)), 0.1);
  assert.equal(rupeesToPaise("2000"), 200000);
});

test("toPaise treats input as paise and rounds", () => {
  assert.equal(toPaise(100), 100);
  assert.equal(toPaise(1.5), 2);
  assert.equal(toPaise("250.75"), 251);
  assert.equal(toPaise(undefined), 0);
  assert.equal(toPaise(null), 0);
});

test("percentageOf computes integer paise share", () => {
  assert.equal(percentageOf(100000, 10), 10000);
  assert.equal(percentageOf(49999, 15), 7500);
});

test("splitWithCommission satisfies commission + technician === total", () => {
  const split = splitWithCommission(49999, 15, 60);
  assert.equal(split.ok, true);
  assert.equal(split.commissionAmountPaise + split.technicianAmountPaise, 49999);
  assert.equal(split.commissionAmountPaise, 7500);
  assert.equal(split.technicianAmountPaise, 42499);
});

test("splitWithCommission rejects percentage above the ceiling", () => {
  const split = splitWithCommission(100000, 75, 60);
  assert.equal(split.ok, false);
  assert.equal(split.error, "percentage_above_ceiling");
});

test("resolveCommissionSnapshot clamps the rate to the ceiling before splitting", async () => {
  const snapshot = await resolveCommissionSnapshot({
    booking: { baseAmount: 499, itemType: "service" },
    service: mockService({ commissionPercentage: 90 }),
    findRule: async () => null, // skip DB in unit tests
  });
  assert.equal(snapshot.commissionPercentage, 60); // clamped to ceiling
  assert.equal(snapshot.commissionAmountPaise, 29940); // 60% of 499.00
});

test("assertSplit throws when the split invariant is broken", () => {
  assert.throws(() =>
    assertSplit({ totalAmountPaise: 1000, commissionAmountPaise: 100, technicianAmountPaise: 200 })
  );
  assert.doesNotThrow(() =>
    assertSplit({ totalAmountPaise: 1000, commissionAmountPaise: 100, technicianAmountPaise: 900 })
  );
});

/* =====================================================
   COMMISSION RESOLUTION — resolve ONCE, never recompute
===================================================== */

const mockService = (overrides = {}) => ({
  _id: "64f1a2b3c4d5e6f7a8b9c0d1",
  serviceCost: 499,
  gstPercentage: 18,
  commissionPercentage: 20,
  ...overrides,
});

test("service default commission: split + GST + tip on server", async () => {
  const snapshot = await resolveCommissionSnapshot({
    booking: { baseAmount: 499, itemType: "service" },
    service: mockService(),
    tipAmountRupees: 50,
    findRule: async () => null, // skip DB in unit tests
  });

  assert.equal(snapshot.calculationVersion, CALCULATION_VERSION);
  assert.equal(snapshot.totalAmountPaise, 49900 + 8982 + 5000); // 499.00 + 89.82 GST + 50 tip
  assert.equal(snapshot.gstAmountPaise, 8982);
  assert.equal(snapshot.commissionPercentage, 20);
  // commission on the BASE amount only (GST and tip never pay commission)
  assert.equal(snapshot.commissionAmountPaise, 9980);
  assert.equal(snapshot.commissionRuleSource, "service_default");
  // Invariant: commission + technician === total (technician absorbs GST + tip)
  assert.equal(
    snapshot.commissionAmountPaise + snapshot.technicianAmountPaise,
    snapshot.totalAmountPaise
  );
  assertSplit(snapshot);
});

test("versioned rule wins over service default", async () => {
  const snapshot = await resolveCommissionSnapshot({
    booking: { baseAmount: 499, itemType: "service" },
    service: mockService(),
    findRule: async () => ({ _id: "rule1", commissionPercentage: 12 }),
  });
  assert.equal(snapshot.commissionRuleSource, "service_rule");
  assert.equal(snapshot.commissionRuleId, "rule1");
  assert.equal(snapshot.commissionPercentage, 12);
  assert.equal(snapshot.commissionAmountPaise, 5988); // 12% of 499.00
});

test("booking-level override wins over everything", async () => {
  const snapshot = await resolveCommissionSnapshot({
    booking: {
      baseAmount: 499,
      itemType: "service",
      commissionOverridden: true,
      commissionAmountPaise: 2500,
    },
    service: mockService(),
    findRule: async () => ({ _id: "rule1", commissionPercentage: 12 }),
  });
  assert.equal(snapshot.commissionRuleSource, "booking_override_amount");
  assert.equal(snapshot.commissionAmountPaise, 2500);
  assert.equal(snapshot.commissionOverridden, true);
});

test("products are hard-zeroed on commission", async () => {
  const snapshot = await resolveCommissionSnapshot({
    booking: { baseAmount: 5000, itemType: "product" },
    service: mockService({ commissionPercentage: 30 }),
  });
  assert.equal(snapshot.commissionAmountPaise, 0);
  assert.equal(snapshot.technicianAmountPaise, 0);
  assert.equal(snapshot.commissionRuleSource, "product_zero");
});

test("platform fallback applies when no rule and no service default", async () => {
  const snapshot = await resolveCommissionSnapshot({
    booking: { baseAmount: 100, itemType: "service" },
    service: { _id: "svc2", serviceCost: 100, gstPercentage: 0, commissionPercentage: 0 },
    findRule: async () => null,
  });
  assert.equal(snapshot.commissionRuleSource, "platform_fallback");
  // COMMISSION_DEFAULT_PERCENTAGE defaults to 0 when unset
  assert.equal(snapshot.commissionPercentage, 0);
  assert.equal(snapshot.commissionAmountPaise, 0);
  assert.equal(snapshot.technicianAmountPaise, 10000);
});

test("stripClientMoneyFields removes every derived money field (baseAmount/tip kept as hints)", () => {
  const cleaned = stripClientMoneyFields({
    baseAmount: 999,
    tipAmount: 50,
    commissionPercentage: 5,
    commissionAmount: 100,
    commissionAmountPaise: 10000,
    technicianAmount: 899,
    technicianAmountPaise: 89900,
    totalAmount: 1049,
    totalAmountPaise: 104900,
    platformRevenue: 50,
    gstAmount: 100,
    gstAmountPaise: 10000,
    address: "Keep me",
    serviceId: "svc1",
  });
  assert.deepEqual(cleaned, {
    baseAmount: 999,
    tipAmount: 50,
    address: "Keep me",
    serviceId: "svc1",
  });
});

test("getActiveCommissionRule picks the newest effective, active rule", async () => {
  const rules = [
    { _id: "r1", commissionPercentage: 5, isActive: false, effectiveFrom: new Date("2024-01-01") },
    { _id: "r2", commissionPercentage: 15, isActive: true, effectiveFrom: new Date("2025-01-01") },
    { _id: "r3", commissionPercentage: 25, isActive: true, effectiveFrom: new Date("2026-01-01") },
  ];
  // findRule receives the serviceId and returns the resolved rule (newest first)
  const rule = await getActiveCommissionRule(
    "64f1a2b3c4d5e6f7a8b9c0d1",
    async () =>
      rules
        .filter((r) => r.isActive && r.effectiveFrom <= new Date())
        .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0] || null
  );
  assert.equal(rule._id, "r3");
});

/* =====================================================
   SETTLEMENT SPLIT — derived from the paid snapshot
===================================================== */

test("deriveSettlementSplit pays job net to technician and isolates tip", () => {
  const split = deriveSettlementSplit({
    booking: {
      financialSnapshot: {
        baseAmountPaise: 49900,
        gstAmountPaise: 8982,
        tipAmountPaise: 5000,
        commissionAmountPaise: 9980,
        technicianAmountPaise: 53902,
        totalAmountPaise: 63882,
      },
    },
    payment: {
      totalAmountPaise: 63882,
      technicianAmountPaise: 53902,
      tipAmountPaise: 5000,
    },
  });
  // technicianAmount = (base − commission) + tip ⇒ job part = 48902, tip = 5000
  assert.equal(split.jobAmountPaise, 48902);
  assert.equal(split.tipAmountPaise, 5000);
  assert.equal(split.mismatch, false);
});

test("deriveSettlementSplit flags a booking/payment mismatch", () => {
  const split = deriveSettlementSplit({
    booking: { financialSnapshot: { totalAmountPaise: 63882, technicianAmountPaise: 53902 } },
    payment: { totalAmountPaise: 50000, technicianAmountPaise: 40000, tipAmountPaise: 0 },
  });
  assert.equal(split.mismatch, true);
});

test("deriveSettlementSplit flags when the payment tip drifts from the booking snapshot tip", () => {
  // v2 decides the tip at booking creation (snapshot). A payment whose tip
  // differs from the snapshot is a genuine mismatch — but the split math must
  // still derive the correct job part (payment tech share − payment tip).
  const split = deriveSettlementSplit({
    booking: {
      financialSnapshot: {
        baseAmountPaise: 49900,
        gstAmountPaise: 8982,
        tipAmountPaise: 5000,
        commissionAmountPaise: 9980,
        technicianAmountPaise: 53902,
        totalAmountPaise: 63882,
      },
    },
    payment: {
      totalAmountPaise: 63882,
      technicianAmountPaise: 51902,
      tipAmountPaise: 3000,
    },
  });
  assert.equal(split.jobAmountPaise, 48902);
  assert.equal(split.tipAmountPaise, 3000);
  assert.equal(split.mismatch, true);
});
