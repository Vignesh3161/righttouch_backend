import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.COMPLETION_OTP_PEPPER = "test-completion-otp-pepper";
process.env.COMPLETION_OTP_SEND_COOLDOWN_MS = "0";
process.env.FAST2SMS_API_KEY = "test-fast2sms-key";

let replSet;
let User;
let ServiceBooking;
let TechnicianProfile;
let TechnicianKyc;
let Payment;
let completionService;
let servicePaymentEligibility;
let paymentReadModel;
let rewardService;
let paymentController;
let customerPaymentController;

const makeRes = () => {
  const res = {};
  res.statusCode = null;
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

let phoneSeq = 0;
const nextPhone = () => String(9000000000 + ++phoneSeq);

const createServiceBooking = async ({ status = "in_progress", paid = false } = {}) => {
  const customer = await User.create({ role: "Customer", mobileNumber: nextPhone() });
  const technicianUser = await User.create({ role: "Technician", mobileNumber: nextPhone() });
  const profile = await TechnicianProfile.create({
    userId: technicianUser._id,
    profileComplete: true,
    workStatus: "approved",
    trainingCompleted: true,
  });
  await TechnicianKyc.create({
    technicianId: profile._id,
    verificationStatus: "approved",
    kycVerified: true,
    bankVerified: true,
  });

  const booking = await ServiceBooking.create({
    customerId: customer._id,
    technicianId: profile._id,
    serviceId: new mongoose.Types.ObjectId(),
    status,
    bookingType: "instant",
    assignmentStatus: "assigned",
    locationType: "saved",
    address: "1 Test Street",
    baseAmount: 100,
    totalAmount: 100,
    paymentStatus: paid ? "paid" : "pending",
    financialSnapshot: {
      baseAmountPaise: 10000,
      totalAmountPaise: 10000,
      commissionPercentage: 10,
      commissionAmountPaise: 1000,
      technicianAmountPaise: 9000,
      calculationVersion: 1,
    },
  });

  return { booking, customer, profile };
};

const payOnline = async (booking) => {
  const payment = await Payment.create({
    bookingId: booking._id,
    itemType: "service",
    paymentType: "SERVICE",
    provider: "razorpay",
    mode: "online",
    status: "success",
    providerPaymentId: `pay_${booking._id}`,
    totalAmountPaise: 10000,
    grossTotalAmountPaise: 10000,
    baseAmountPaise: 10000,
  });
  await ServiceBooking.updateOne(
    { _id: booking._id },
    { $set: { paymentStatus: "paid", paymentId: payment._id } }
  );
  return payment;
};

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { directConnection: true });

  ({ default: User } = await import("../Schemas/User.js"));
  ({ default: ServiceBooking } = await import("../Schemas/ServiceBooking.js"));
  ({ default: TechnicianProfile } = await import("../Schemas/TechnicianProfile.js"));
  ({ default: TechnicianKyc } = await import("../Schemas/TechnicianKYC.js"));
  ({ default: Payment } = await import("../Schemas/Payment.js"));
  completionService = await import("../Services/completionVerificationService.js");
  servicePaymentEligibility = await import("../Utils/servicePaymentEligibility.js");
  paymentReadModel = await import("../Utils/paymentReadModel.js");
  rewardService = await import("../Services/rewardService.js");
  paymentController = await import("../Controllers/paymentController.js");
  customerPaymentController = await import("../Controllers/customerPaymentController.js");
});

after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

test("service payment opens only after the completion OTP is requested", async () => {
  const { booking } = await createServiceBooking();
  assert.equal(servicePaymentEligibility.isServicePaymentEligible(booking), false);
  assert.equal(paymentReadModel.isBookingPayable({ ...booking.toObject(), itemType: "service" }), false);

  booking.completionOtpRequestedAt = new Date();
  assert.equal(servicePaymentEligibility.isServicePaymentEligible(booking), true);
  assert.equal(paymentReadModel.isBookingPayable({ ...booking.toObject(), itemType: "service" }), true);

  const completedUnpaid = { status: "completed", paymentStatus: "pending" };
  assert.equal(servicePaymentEligibility.isServicePaymentEligible(completedUnpaid), true);

  const product = { itemType: "product", status: "active", paymentStatus: "pending" };
  assert.equal(paymentReadModel.isBookingPayable(product), true);
});

test("verify refuses OTP before payment, then completes after an online payment", async () => {
  const { booking, profile } = await createServiceBooking();
  const sent = [];
  await completionService.requestCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async (_phone, otp) => sent.push(otp),
  });

  const marked = await ServiceBooking.findById(booking._id).lean();
  assert.ok(marked.completionOtpRequestedAt instanceof Date);

  const challengeBefore = await mongoose.model("ServiceCompletionChallenge").findOne({
    bookingId: booking._id,
  }).lean();
  await assert.rejects(
    () => completionService.verifyCompletionOtp({
      bookingId: booking._id,
      technicianProfileId: profile._id,
      otp: sent[0],
    }),
    (err) => err.code === "PAYMENT_REQUIRED" && err.statusCode === 409
  );
  const challengeAfter = await mongoose.model("ServiceCompletionChallenge").findOne({
    bookingId: booking._id,
  }).lean();
  assert.equal(challengeAfter.attempts, challengeBefore.attempts);
  assert.equal(challengeAfter.status, "pending");

  await payOnline(booking);
  const result = await completionService.verifyCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    otp: sent[0],
  });
  assert.equal(result.booking.status, "completed");
  assert.equal(result.booking.paymentStatus, "paid");
});

test("verify rejects a paid booking whose Payment record is offline", async () => {
  const { booking, profile } = await createServiceBooking();
  const sent = [];
  await completionService.requestCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async (_phone, otp) => sent.push(otp),
  });

  await Payment.create({
    bookingId: booking._id,
    itemType: "service",
    paymentType: "SERVICE",
    provider: "razorpay",
    mode: "cash",
    status: "success",
    totalAmountPaise: 10000,
    grossTotalAmountPaise: 10000,
  });
  await ServiceBooking.updateOne({ _id: booking._id }, { $set: { paymentStatus: "paid" } });

  await assert.rejects(
    () => completionService.verifyCompletionOtp({
      bookingId: booking._id,
      technicianProfileId: profile._id,
      otp: sent[0],
    }),
    (err) => err.code === "PAYMENT_REQUIRED" && err.statusCode === 409
  );
  const unchanged = await ServiceBooking.findById(booking._id).lean();
  assert.equal(unchanged.status, "in_progress");
});

test("resend after payment rotates the OTP and still completes", async () => {
  const { booking, profile } = await createServiceBooking();
  const sent = [];
  await completionService.requestCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async (_phone, otp) => sent.push(otp),
  });
  await payOnline(booking);

  await completionService.resendCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async (_phone, otp) => sent.push(otp),
  });
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1]);

  await assert.rejects(
    () => completionService.verifyCompletionOtp({
      bookingId: booking._id,
      technicianProfileId: profile._id,
      otp: sent[0],
    }),
    (err) => err.code === "INVALID"
  );

  const result = await completionService.verifyCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    otp: sent[1],
  });
  assert.equal(result.booking.status, "completed");
});

test("service payment order is rejected until the OTP marker is set", async () => {
  const { booking, customer } = await createServiceBooking();
  const req = {
    user: { role: "Customer", userId: customer._id.toString() },
    body: { bookingId: booking._id.toString() },
  };
  const res = makeRes();

  await paymentController.createPaymentOrder(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.result?.code, "PAYMENT_NOT_DUE");
});

test("offline and cash recording is disabled for service bookings", async () => {
  const { booking, customer } = await createServiceBooking();

  const offlineRes = makeRes();
  await paymentController.recordAdminOfflinePayment(
    {
      user: { role: "Admin", userId: new mongoose.Types.ObjectId().toString() },
      params: { bookingId: booking._id.toString() },
      body: { paymentMode: "cash", amount: 100 },
    },
    offlineRes
  );
  assert.equal(offlineRes.statusCode, 400);
  assert.equal(offlineRes.body?.result?.code, "SERVICE_OFFLINE_PAYMENT_DISABLED");
  assert.equal(await Payment.countDocuments({ bookingId: booking._id }), 0);

  const cashRes = makeRes();
  await customerPaymentController.declareCashPayment(
    {
      user: { role: "Customer", userId: customer._id.toString() },
      params: { bookingId: booking._id.toString() },
      body: {},
    },
    cashRes
  );
  assert.equal(cashRes.statusCode, 400);
  assert.equal(cashRes.body?.result?.code, "SERVICE_OFFLINE_PAYMENT_DISABLED");
});

test("product offline payments remain available", async () => {
  const customer = await User.create({ role: "Customer", mobileNumber: nextPhone() });
  const ProductBooking = mongoose.model("ProductBooking");
  const productBooking = await ProductBooking.create({
    productId: new mongoose.Types.ObjectId(),
    customerId: customer._id,
    amount: 100,
    amountPaise: 10000,
    locationType: "saved",
    status: "active",
    financialSnapshot: {
      baseAmountPaise: 10000,
      totalAmountPaise: 10000,
      calculationVersion: 1,
    },
  });

  const res = makeRes();
  await paymentController.recordAdminOfflinePayment(
    {
      user: { role: "Admin", userId: new mongoose.Types.ObjectId().toString() },
      params: { bookingId: productBooking._id.toString() },
      body: { paymentMode: "cash", amount: 100 },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  const payment = await Payment.findOne({ bookingId: productBooking._id }).lean();
  assert.equal(payment.status, "success");
  assert.equal(payment.provider, "offline");
  const fresh = await ProductBooking.findById(productBooking._id).lean();
  assert.equal(fresh.paymentStatus, "paid");
});

test("customer payment summary counts an OTP-requested booking exactly once", async () => {
  const { booking, customer } = await createServiceBooking();
  await ServiceBooking.updateOne(
    { _id: booking._id },
    { $set: { completionOtpRequestedAt: new Date() } }
  );

  const req = { user: { role: "Customer", userId: customer._id.toString() } };
  const first = makeRes();
  await customerPaymentController.getMyPaymentSummary(req, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.result.dueCount, 1);
  assert.equal(first.body.result.amountDuePaise, 10000);

  await Payment.create({
    bookingId: booking._id,
    itemType: "service",
    status: "pending",
    totalAmountPaise: 10000,
    grossTotalAmountPaise: 10000,
  });

  const second = makeRes();
  await customerPaymentController.getMyPaymentSummary(req, second);
  assert.equal(second.body.result.dueCount, 1);
  assert.equal(second.body.result.amountDuePaise, 10000);
});

test("reward redemption quote follows service payment eligibility", async () => {
  const { booking, customer } = await createServiceBooking();
  const RewardPolicy = (await import("../Schemas/RewardPolicy.js")).default;
  await RewardPolicy.create({
    version: 1,
    isActive: true,
    earningEnabled: true,
    redemptionEnabled: true,
    rewardRateBps: 100,
  });

  const before = await rewardService.getRewardRedemptionQuote({
    customerId: customer._id,
    booking: { ...booking.toObject(), itemType: "service" },
  });
  assert.equal(before.reason, "booking_not_payable");

  const after = await rewardService.getRewardRedemptionQuote({
    customerId: customer._id,
    booking: {
      ...booking.toObject(),
      itemType: "service",
      completionOtpRequestedAt: new Date(),
    },
  });
  assert.notEqual(after.reason, "booking_not_payable");
});
