import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

let replSet;
let TechnicianProfile;
let TechnicianKyc;
let WithdrawalRequest;
let GlobalSetting;
let autoPayout;
let technicianWalletController;
let adminWalletController;
let fingerprintBankDetails;

const makeRes = () => {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

const createTechnician = async ({ balancePaise = 0, bankDetails = null } = {}) =>
  TechnicianProfile.create({
    userId: new mongoose.Types.ObjectId(),
    workStatus: "approved",
    availableBalancePaise: balancePaise,
    ...(bankDetails ? { bankDetails } : {}),
  });

const makeBank = (accountNumber = "9999888877776666", ifscCode = "ICIC0000001") => ({
  accountHolderName: "Test Technician",
  accountNumber,
  ifscCode,
  upiId: "",
});

const createVerifiedKyc = async (technicianId, bankDetails) => {
  await TechnicianKyc.create({
    technicianId,
    verificationStatus: "approved",
    kycVerified: true,
    bankVerified: true,
    bankVerificationStatus: "approved",
    bankDetails,
    bankDetailsFingerprint: fingerprintBankDetails(bankDetails),
  });
};

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { directConnection: true });

  ({ default: TechnicianProfile } = await import("../Schemas/TechnicianProfile.js"));
  ({ default: TechnicianKyc } = await import("../Schemas/TechnicianKYC.js"));
  ({ default: WithdrawalRequest } = await import("../Schemas/WithdrawalRequest.js"));
  ({ default: GlobalSetting } = await import("../Schemas/GlobalSetting.js"));
  autoPayout = await import("../Utils/autoPayout.js");
  technicianWalletController = await import("../Controllers/technicianWalletController.js");
  adminWalletController = await import("../Controllers/adminWalletController.js");
  ({ fingerprintBankDetails } = await import("../Utils/kycPrivacy.js"));
});

after(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

test("auto-payout estimate is never eligible in manual-only mode", () => {
  const estimate = autoPayout.computeAutoPayoutForTech(
    { availableBalancePaise: 1000000 },
    {
      autoPayoutEnabled: true,
      autoPayoutThresholdPaise: 500000,
      minimumMaintenancePaise: 10000,
    }
  );

  assert.equal(autoPayout.AUTO_PAYOUT_EXECUTION_ENABLED, false);
  assert.equal(estimate.eligible, false);
  assert.equal(estimate.reason, "auto_payout_execution_disabled");
  assert.equal(estimate.executionEnabled, false);
});

test("technician withdrawal minimum is read from GlobalSetting", async () => {
  await GlobalSetting.create({ key: "payout.minWithdrawalAmountPaise", value: 500000 }); // ₹5,000
  const tech = await createTechnician({ balancePaise: 1000000 });

  const res = makeRes();
  await technicianWalletController.requestWithdrawal(
    {
      body: { amountPaise: 10000 }, // ₹100
      technician: tech,
      user: { userId: new mongoose.Types.ObjectId(), role: "Technician" },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Minimum withdrawal amount is ₹5000/);
});

test("technician withdrawal cooldown is read from GlobalSetting", async () => {
  await GlobalSetting.create({ key: "payout.withdrawalCooldownDays", value: 7 });
  const bank = makeBank();
  const tech = await createTechnician({ balancePaise: 1000000 });
  await createVerifiedKyc(tech._id, bank);

  await WithdrawalRequest.create({
    technicianId: tech._id,
    amount: 100,
    amountPaise: 10000,
    requestedAmountPaise: 10000,
    netPayoutAmountPaise: 10000,
    status: "paid",
    origin: "technician_request",
    paidAt: new Date(),
  });

  const res = makeRes();
  await technicianWalletController.requestWithdrawal(
    {
      body: { amountPaise: 20000 },
      technician: tech,
      user: { userId: new mongoose.Types.ObjectId(), role: "Technician" },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /cooldown active/);
});

test("admin manual payout uses the canonical dual-approval threshold key", async () => {
  await GlobalSetting.create({ key: "payout.dualApprovalThresholdPaise", value: 3000000 }); // ₹30,000
  const tech = await createTechnician({ balancePaise: 2000000 }); // ₹20,000
  await createVerifiedKyc(tech._id, makeBank());

  const res = makeRes();
  await adminWalletController.adminManualPayoutToTechnician(
    {
      params: { technicianId: String(tech._id) },
      body: { amountPaise: 1500000, reason: "manual payout regression test" }, // ₹15,000
      user: { userId: new mongoose.Types.ObjectId(), role: "Admin" },
    },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.result.status, "approved");

  const saved = await WithdrawalRequest.findById(res.body.result.withdrawalId).lean();
  assert.equal(saved.origin, "admin_direct");
  assert.equal(saved.requiresApproval, false);
});

test("admin manual payout still honours the legacy dual-approval key", async () => {
  await GlobalSetting.create({ key: "payout.adminManualDualApprovalPaise", value: 500000 }); // ₹5,000
  const tech = await createTechnician({ balancePaise: 2000000 });
  await createVerifiedKyc(tech._id, makeBank());

  const res = makeRes();
  await adminWalletController.adminManualPayoutToTechnician(
    {
      params: { technicianId: String(tech._id) },
      body: { amountPaise: 1500000, reason: "legacy threshold regression test" },
      user: { userId: new mongoose.Types.ObjectId(), role: "Admin" },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.status, "requested");
  assert.equal(res.body.result.needsSecondApproval, true);
});

test("auto payout summary counts legacy origin=auto records, not a type field", async () => {
  const tech = await createTechnician();
  await WithdrawalRequest.create([
    {
      technicianId: tech._id,
      amount: 100,
      amountPaise: 10000,
      status: "paid",
      origin: "auto",
    },
    {
      technicianId: tech._id,
      amount: 200,
      amountPaise: 20000,
      status: "paid",
      origin: "technician_request",
    },
  ]);

  const res = makeRes();
  await adminWalletController.getAutoPayoutSummary(
    { user: { userId: new mongoose.Types.ObjectId(), role: "Admin" }, query: {} },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.manualOnly, true);
  assert.equal(res.body.result.deprecated, true);
  assert.equal(res.body.result.autoPayoutExecutionEnabled, false);
  assert.equal(res.body.result.totalAutoPayouts, 1);
  assert.equal(res.body.result.totalAmountPaidPaise, 10000);
});

test("wallet payout destination comes from the KYC bank record", async () => {
  const tech = await createTechnician({
    balancePaise: 500000,
    bankDetails: makeBank("1111222233334444", "HDFC0000001"),
  });
  await createVerifiedKyc(tech._id, makeBank("9999888877776666", "ICIC0000001"));

  const res = makeRes();
  await technicianWalletController.getTechnicianWallet({ technician: tech }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.autoPayoutExecutionEnabled, false);
  assert.equal(res.body.payoutDestination, "Bank Account (****6666)");
  assert.match(res.body.nextAutoPayoutEstimate.message, /Auto-payout execution is disabled/);
});

test("technician withdrawal maximum is read from GlobalSetting", async () => {
  await GlobalSetting.create({ key: "payout.maxWithdrawalAmountPaise", value: 300000 }); // ₹3,000
  const tech = await createTechnician({ balancePaise: 1000000 });

  const res = makeRes();
  await technicianWalletController.requestWithdrawal(
    {
      body: { amountPaise: 500000 }, // ₹5,000
      technician: tech,
      user: { userId: new mongoose.Types.ObjectId(), role: "Technician" },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Maximum withdrawal limit per request is ₹3000/);
});

test("admin direct payout maximum is read from GlobalSetting", async () => {
  await GlobalSetting.create({ key: "payout.maxWithdrawalAmountPaise", value: 500000 }); // ₹5,000
  const tech = await createTechnician({ balancePaise: 2000000 });
  await createVerifiedKyc(tech._id, makeBank());

  const res = makeRes();
  await adminWalletController.adminManualPayoutToTechnician(
    {
      params: { technicianId: String(tech._id) },
      body: { amountPaise: 1000000, reason: "max limit regression test" }, // ₹10,000
      user: { userId: new mongoose.Types.ObjectId(), role: "Admin" },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /maximum withdrawal limit of ₹5000\.00/);
});

test("admin direct payout uses the full balance when the global floor is zero", async () => {
  await GlobalSetting.create([
    { key: "payout.minimumMaintenancePaise", value: 0 },
    { key: "payout.minWithdrawalAmountPaise", value: 100 }, // ₹1
  ]);
  const tech = await createTechnician({ balancePaise: 176 });
  await TechnicianProfile.updateOne(
    { _id: tech._id },
    { $set: { "payoutSettings.minimumMaintenancePaise": 10000 } }
  );
  await createVerifiedKyc(tech._id, makeBank());

  const res = makeRes();
  await adminWalletController.adminManualPayoutToTechnician(
    {
      params: { technicianId: String(tech._id) },
      body: { amountPaise: 176, reason: "full balance regression test" },
      user: { userId: new mongoose.Types.ObjectId(), role: "Admin" },
    },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.result.status, "approved");

  const saved = await WithdrawalRequest.findById(res.body.result.withdrawalId).lean();
  assert.equal(saved.origin, "admin_direct");
  assert.equal(saved.amountPaise, 176);

  const updatedTech = await TechnicianProfile.findById(tech._id).lean();
  assert.equal(updatedTech.availableBalancePaise, 0);
  assert.equal(updatedTech.reservedBalancePaise, 176);
});

test("admin direct payout enforces the global maintenance floor", async () => {
  await GlobalSetting.create({ key: "payout.minimumMaintenancePaise", value: 10000 }); // ₹100
  const tech = await createTechnician({ balancePaise: 100000 }); // ₹1,000
  await createVerifiedKyc(tech._id, makeBank());

  const res = makeRes();
  await adminWalletController.adminManualPayoutToTechnician(
    {
      params: { technicianId: String(tech._id) },
      body: { amountPaise: 100000, reason: "global floor regression test" },
      user: { userId: new mongoose.Types.ObjectId(), role: "Admin" },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /withdrawable balance of ₹900\.00/);
  assert.match(res.body.message, /maintenance floor ₹100\.00 must remain/);
});

test("technician withdrawal uses the full balance when the global floor is zero", async () => {
  await GlobalSetting.create([
    { key: "payout.minimumMaintenancePaise", value: 0 },
    { key: "payout.minWithdrawalAmountPaise", value: 100 }, // ₹1
  ]);
  const tech = await createTechnician({ balancePaise: 10000 }); // ₹100
  await TechnicianProfile.updateOne(
    { _id: tech._id },
    { $set: { "payoutSettings.minimumMaintenancePaise": 10000 } }
  );
  await createVerifiedKyc(tech._id, makeBank());

  const res = makeRes();
  await technicianWalletController.requestWithdrawal(
    {
      body: { amountPaise: 10000 },
      technician: tech,
      user: { userId: new mongoose.Types.ObjectId(), role: "Technician" },
    },
    res
  );

  assert.equal(res.statusCode, 201);
  const saved = await WithdrawalRequest.findById(res.body.result.withdrawalId).lean();
  assert.equal(saved.amountPaise, 10000);

  const updatedTech = await TechnicianProfile.findById(tech._id).lean();
  assert.equal(updatedTech.availableBalancePaise, 0);
  assert.equal(updatedTech.reservedBalancePaise, 10000);
});

test("admin wallet overview exposes policy limits and bank readiness", async () => {
  await GlobalSetting.create([
    { key: "payout.minimumMaintenancePaise", value: 0 },
    { key: "payout.minWithdrawalAmountPaise", value: 100 }, // ₹1
    { key: "payout.maxWithdrawalAmountPaise", value: 5000000 }, // ₹50,000
  ]);
  const tech = await createTechnician({ balancePaise: 176 });
  await createVerifiedKyc(tech._id, makeBank());

  const res = makeRes();
  await adminWalletController.getTechnicianWalletOverview(
    {
      params: { technicianId: String(tech._id) },
      user: { userId: new mongoose.Types.ObjectId(), role: "Admin" },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.maintenanceFloorPaise, 0);
  assert.equal(res.body.result.minimumWithdrawalAmountPaise, 100);
  assert.equal(res.body.result.maximumWithdrawalAmountPaise, 5000000);
  assert.equal(res.body.result.adminDirectMaxWithdrawablePaise, 176);
  assert.equal(res.body.result.maxWithdrawablePaise, 176);
  assert.equal(res.body.result.eligibility.hasBankFingerprint, true);
});

test("payout settings expose, persist and validate the global maximum", async () => {
  const getRes = makeRes();
  await adminWalletController.getAutoPayoutSettings(
    { user: { userId: new mongoose.Types.ObjectId(), role: "Admin" } },
    getRes
  );

  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.result.maxWithdrawalAmountPaise, 5000000);
  assert.equal(getRes.body.result.maxWithdrawalAmount, 50000);
  assert.ok(getRes.body.result.deprecatedAutoPayoutFields.includes("autoPayoutThreshold"));

  const updateRes = makeRes();
  await adminWalletController.updateAutoPayoutSettings(
    {
      body: { maxWithdrawalAmount: 7500 },
      user: { userId: new mongoose.Types.ObjectId(), role: "Admin" },
    },
    updateRes
  );

  assert.equal(updateRes.statusCode, 200);
  assert.equal(updateRes.body.result.maxWithdrawalAmountPaise, 750000);

  const config = await autoPayout.getAutoPayoutConfig();
  assert.equal(config.maxWithdrawalAmountPaise, 750000);

  const invalidRes = makeRes();
  await adminWalletController.updateAutoPayoutSettings(
    {
      body: { minWithdrawalAmount: 10000, maxWithdrawalAmount: 5000 },
      user: { userId: new mongoose.Types.ObjectId(), role: "Admin" },
    },
    invalidRes
  );

  assert.equal(invalidRes.statusCode, 400);
  assert.match(invalidRes.body.message, /minWithdrawalAmount must be <= maxWithdrawalAmount/);
});

test("admin withdrawal list no longer exposes legacy profile bank fields", async () => {
  const tech = await createTechnician({
    balancePaise: 100000,
    bankDetails: makeBank("1111222233334444", "HDFC0000001"),
  });
  await WithdrawalRequest.create({
    technicianId: tech._id,
    amount: 100,
    amountPaise: 10000,
    requestedAmountPaise: 10000,
    netPayoutAmountPaise: 10000,
    status: "requested",
    origin: "technician_request",
    payoutBlocked: false,
  });

  const res = makeRes();
  await adminWalletController.getAllWithdrawalRequests(
    { query: {}, user: { userId: new mongoose.Types.ObjectId(), role: "Admin" } },
    res
  );

  assert.equal(res.statusCode, 200);
  const rowTech = res.body.result[0].technicianId;
  assert.equal(rowTech.bankDetails, undefined);
  assert.equal(rowTech.decryptedBankDetails, undefined);
  assert.equal(rowTech.kycDetails, undefined);
  assert.equal(rowTech.isBankVerified, undefined);
  assert.equal(rowTech.payoutBlocked, false);
});
