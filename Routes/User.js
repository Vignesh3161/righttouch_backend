import express from "express";
import { upload } from "../Utils/bunnyUpload.js";
import rateLimit from 'express-rate-limit';
import {
  signupAndSendOtp,
  resendOtp,
  verifyOtp,
  setPassword,
  login,
  technicianLogin,
  ownerLogin,
  getMyProfile,
  completeProfile,
  updateMyProfile,
  getUserById,
  getAllUsers,
  deleteUserById,
  checkUserByIdentifier,
  requestLoginOtp,
  verifyLoginOtp,
  acceptTerms,
} from "../Controllers/User.js";

import { deleteMyAccount } from "../Controllers/accountController.js";
import {
  refreshSession,
  logoutSession,
  logoutAllSessions,
} from "../Controllers/refreshTokenController.js";

// ...existing code...



import {
  serviceCategory,
  uploadCategoryImage,
  removeCategoryImage,
  getAllCategory,
  getByIdCategory,
  updateCategory,
  deleteCategory,
} from "../Controllers/categoryController.js";

import {
  userRating,
  getAllRatings,
  getRatingById,
  updateRatingController,
  deleteRatingController,
  adminUpdateRatingController,
  adminDeleteRatingController,
  getMyRatings,
  rebuildAggregateController,
} from "../Controllers/ratingController.js";

import {
  userReport,
  getAllReports,
  getReportById,
  getMyReports,
  resolveReport,
} from "../Controllers/reportController.js";

import {
  createService,
  uploadServiceImages,
  removeServiceImage,
  replaceServiceImages,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
  getServicePolygon,
  setServicePolygon,
  removeServicePolygon,
  toggleZoneRestriction,
} from "../Controllers/serviceController.js";

import {
  createBooking,
  getBookings,
  getBookingSchedule,
  storeBookingSchedule,
  rescheduleBooking,
  getCustomerBookings,
  cancelBooking,
  getCancellationReasons,
  deleteAllCustomerBookings,
  deleteServiceBooking,
  deleteBookingAsAdmin,
  getOwnerAllBookings,
  getOwnerBookingById,
  getCompletedServices,
  rebookService,
  getCompletionStatus,
  respondToCustomerNoShow,
} from "../Controllers/serviceBookController.js";
import { reviewCustomerNoShowCompensation } from "../Controllers/customerNoShowAdminController.js";


import {
  createProduct,
  getProduct,
  getOneProduct,
  deleteProduct,
  uploadProductImages,
  removeProductImage,
  replaceProductImages,
  updateProduct,
} from "../Controllers/productController.js";

import {
  getAllProductBooking,
  productBookingUpdate,
  productBookingCancel,
  adminCompleteProductBooking,
} from "../Controllers/productBooking.js";

import {
  createPaymentOrder,
  verifyPayment,
  razorpayWebhook,
  updatePaymentStatus,
  retryPaymentSettlement,
  getPaymentByBooking,
} from "../Controllers/paymentController.js";

import {
  addToCart,
  getMyCart,
  updateCartItem,
  removeFromCart,
  getCartById,
  updateCartById,
  setCartItemSchedule,
  checkout,
  getCartByIdUnrestricted,
  removeFromCartUnrestricted,
} from "../Controllers/cartController.js";

import { Auth } from "../Middleware/Auth.js";


const router = express.Router();


router.post("/auth/accept-terms", Auth, acceptTerms);
router.delete("/delete-my-account", Auth, deleteMyAccount);

// H3: limiter keys use Express's `req.ip` (trust-proxy aware) — never a
// hand-parsed X-Forwarded-For, which clients can spoof to evade limits.
// Requires TRUST_PROXY to match the real proxy hop count in production.
const getClientIp = (req) => {
  if (req.ip) return req.ip;
  return req.socket?.remoteAddress || "unknown";
};

// 🔒 Strict Rate Limiters for Authentication
const authLimiter = rateLimit({
  //sk
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 attempts per window (increased for testing)
  message: {
    success: false,
    message: "Too many attempts, please try again after 15 minutes",
    result: {},
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});

const otpLimiter = rateLimit({
  windowMs: 60 * 1000, // 60 Seconds
  max: 10, // 10 OTP requests per window
  message: {
    success: false,
    message: "Too many OTP requests, please try again after 1 minute",
    result: {},
  },
  standardHeaders: true,
  legacyHeaders: false,
  // H3: default keyGenerator (req.ip, trust-proxy aware) — no XFF parsing.
});

// ================= UNIFIED OTP LOGIN (ALL ROLES) =================
// Use a single endpoint for all roles, DRY and secure
// H2: OTP issuance + verification must always sit behind the OTP limiter —
// these endpoints previously had no rate limiting at all.
router.post("/auth/login/request-otp", otpLimiter, requestLoginOtp);
router.post("/auth/login/verify-otp", otpLimiter, verifyLoginOtp);

// Rotating refresh tokens (all roles) + current-device / all-device logout.
router.post("/auth/refresh", authLimiter, refreshSession);
router.post("/auth/logout", authLimiter, logoutSession);
router.post("/auth/logout-all", Auth, logoutAllSessions);

/* ================= USER ================= */
router.post("/signup", authLimiter, signupAndSendOtp);
router.post("/resend-otp", otpLimiter, resendOtp);
// H1/H2: OTP verification guesses are bounded per-IP (10/min) on top of the
// per-OTP atomic 5-attempt budget enforced in authService.
router.post("/verify-otp", otpLimiter, verifyOtp);
router.post("/set-password", authLimiter, Auth, setPassword);
router.post("/login", authLimiter, login);

/* ================= CUSTOMER SIGNUP (TERMS REQUIRED) ================= */
// Customer signup route - requires termsAccepted
router.post("/signup/customer", authLimiter, async (req, res, next) => {
  req.body = req.body || {};
  req.body.role = "Customer";
  // termsAccepted must be sent in body
  return signupAndSendOtp(req, res, next);
});

// Customer: verify OTP after signup
router.post("/signup/customer/verify-otp", otpLimiter, verifyOtp);

/* ================= USER LOGIN ROUTES (Role-specific) ================= */
// Customer login (default, only allows Customer role)
router.post("/login/customer", authLimiter, async (req, res, next) => {
  req.body = req.body || {};
  req.body.role = "Customer";
  return login(req, res, next);
});

// Customer: verify OTP (role pre-filled)
router.post("/login/customer/verify-otp", otpLimiter, verifyOtp);


// Owner login (only allows Owner role)
router.post("/login/owner", authLimiter, ownerLogin);

// ---------------- Owner-specific registration/login routes ----------------
// Owner: request signup OTP (role pre-filled)
router.post("/owner/signup", authLimiter, async (req, res, next) => {
  req.body = req.body || {};
  req.body.role = "Owner";
  return signupAndSendOtp(req, res, next);
});

// Owner: verify OTP
router.post("/owner/verify-otp", otpLimiter, async (req, res, next) => {
  // req.body.role = "Owner";
  return verifyOtp(req, res, next);
});

// Owner: set password after OTP verified
router.post("/owner/set-password", authLimiter, Auth, async (req, res, next) => {
  // req.body.role = "Owner";
  return setPassword(req, res, next);
});

// Owner: login (role-restricted)
router.post("/owner/login", authLimiter, ownerLogin);

// 🔍 DEBUG: Check user by identifier (PROTECTED, OWNER/ADMIN ONLY)
import { authorizeRoles } from "../Middleware/Auth.js";
router.get("/debug/check-user/:identifier", Auth, authorizeRoles("Owner", "Admin"), checkUserByIdentifier);

router.get("/me", Auth, getMyProfile);
router.post("/complete-profile", Auth, completeProfile);
router.put("/me", Auth, updateMyProfile);
// 🔒 Admin/Owner only — user PII & account management
router.get("/users/:role/:id", Auth, authorizeRoles("Admin", "Owner"), getUserById);
router.get("/users/:role", Auth, authorizeRoles("Admin", "Owner"), getAllUsers);
router.delete("/users/:id", Auth, authorizeRoles("Owner"), deleteUserById);

/* ================= CATEGORY ================= */
router.post("/category", Auth, authorizeRoles("Owner"), serviceCategory);
router.post(
  "/category/upload-image",
  Auth,
  authorizeRoles("Owner"),
  upload.single("image"),
  uploadCategoryImage
);
router.delete("/category/remove-image", Auth, authorizeRoles("Owner"), removeCategoryImage);
router.get("/getAllcategory", getAllCategory);
router.get("/getByIdcategory/:id", getByIdCategory);
router.put("/updatecategory/:id", Auth, authorizeRoles("Owner"), updateCategory);
router.delete("/deletecategory/:id", Auth, authorizeRoles("Owner"), deleteCategory);

/* ================= REPORT ================= */
router.post("/report", Auth, userReport);
router.get("/getAllReports", Auth, authorizeRoles("Admin", "Owner"), getAllReports);
router.get("/get-my-reports", Auth, getMyReports);
router.get("/getReportById/:id", Auth, authorizeRoles("Admin", "Owner"), getReportById);
router.put("/report/resolve/:id", Auth, authorizeRoles("Admin", "Owner"), resolveReport);

/* ================= SERVICE ================= */
router.post("/service", Auth, authorizeRoles("Owner"), createService);
router.post(
  "/services/upload-images",
  Auth,
  authorizeRoles("Owner"),
  upload.array("serviceImages", 5),
  uploadServiceImages
);
router.delete("/services/remove-image", Auth, authorizeRoles("Owner"), removeServiceImage);
router.put(
  "/services/replace-images",
  Auth,
  authorizeRoles("Owner"),
  upload.array("serviceImages", 5),
  replaceServiceImages
);
router.get("/getAllServices", getAllServices);
router.get("/getServiceById/:id", getServiceById);
router.put("/updateService/:id", Auth, authorizeRoles("Owner"), updateService);
router.put("/service/:id/zone-restriction", Auth, authorizeRoles("Owner"), toggleZoneRestriction);
router.delete("/services/:id", Auth, authorizeRoles("Owner"), deleteService);

/* ================= SERVICE COVERAGE POLYGON (Admin/Owner) ================= */
// Polygon = where the service can be booked + where technicians get matched
router.get("/service/:id/polygon", Auth, getServicePolygon);
router.put("/service/:id/polygon", Auth, authorizeRoles("Owner"), setServicePolygon);
router.delete("/service/:id/polygon", Auth, authorizeRoles("Owner"), removeServicePolygon);

/* ================= SERVICE BOOKING ================= */
router.get("/service/booking", Auth, getBookings);
const optionalAuth = (req, res, next) => {
  if (!req.headers.authorization) return next();
  return Auth(req, res, next);
};
router.get("/booking/slots", optionalAuth, getBookingSchedule);
router.post("/booking/schedule", Auth, storeBookingSchedule);
router.put("/booking/reschedule/:id", Auth, rescheduleBooking);
router.put("/booking/cancel/:id", Auth, cancelBooking);
router.get("/booking/reasons", Auth, getCancellationReasons);
router.get("/booking/getCustomerBookings", Auth, getCustomerBookings);
// Safe completion-verification status only (no OTP/hash/phone ever).
router.get("/booking/:id/completion-status", Auth, getCompletionStatus);
router.post("/booking/:id/customer-no-show/respond", Auth, respondToCustomerNoShow);
router.delete("/booking/deleteAll", Auth, deleteAllCustomerBookings);
router.delete("/booking/:id", Auth, deleteServiceBooking);
router.delete("/booking/admin/:id", Auth, authorizeRoles("Admin", "Owner"), deleteBookingAsAdmin);
router.put("/booking/:id/customer-no-show/compensation", Auth, authorizeRoles("Owner"), reviewCustomerNoShowCompensation);

/* ================= BOOK AGAIN ================= */
router.get("/booking/completed-services", Auth, getCompletedServices);
router.post("/booking/book-again", Auth, rebookService);


/* ================= OWNER BOOKING MANAGEMENT ================= */
router.get("/booking/getAllBookings", Auth, authorizeRoles("Admin", "Owner"), getOwnerAllBookings);
router.get("/booking/getBookingById/:id", Auth, authorizeRoles("Admin", "Owner"), getOwnerBookingById);

/* ================= RATING ================= */
router.post("/rating", Auth, userRating);
// 🔒 Full rating table contains PII — Admin/Owner only. Customers use /ratings and /get-my-ratings.
router.get("/getAllRatings", Auth, authorizeRoles("Admin", "Owner"), getAllRatings);

// Customer rating history + read (architecture §45)
router.get("/ratings", Auth, getMyRatings);
router.get("/ratings/:id", Auth, getRatingById);

router.get("/getRatingById/:id", Auth, getRatingById);
router.put("/updateRating/:id", Auth, updateRatingController);
router.delete("/deleteRating/:id", Auth, deleteRatingController);
router.get("/get-my-ratings", Auth, getMyRatings);

// Admin/owner reconciliation — rebuild a stale aggregate (architecture §23)
router.post(
  "/admin/ratings/rebuild/:targetType/:targetId",
  Auth,
  authorizeRoles("Admin", "Owner"),
  rebuildAggregateController
);
// Admin/owner filtered rating view (architecture §46)
router.get(
  "/admin/ratings",
  Auth,
  authorizeRoles("Admin", "Owner"),
  getAllRatings
);
router.put(
  "/admin/ratings/:id",
  Auth,
  authorizeRoles("Admin", "Owner"),
  adminUpdateRatingController
);
router.delete(
  "/admin/ratings/:id",
  Auth,
  authorizeRoles("Admin", "Owner"),
  adminDeleteRatingController
);

/* ================= PRODUCT ================= */
router.post("/product", Auth, authorizeRoles("Owner"), createProduct);
router.post(
  "/product/upload-images",
  Auth,
  authorizeRoles("Owner"),
  upload.array("productImages", 5),
  uploadProductImages
);
router.delete("/product/remove-image", Auth, authorizeRoles("Owner"), removeProductImage);
router.put(
  "/product/replace-images",
  Auth,
  authorizeRoles("Owner"),
  upload.array("productImages", 5),
  replaceProductImages
);
router.get("/getProduct", getProduct);
router.get("/getOneProduct/:id", getOneProduct);
router.put(
  "/updateProduct/:id",
  Auth,
  authorizeRoles("Owner"),
  upload.array("productImages", 5),
  updateProduct
);
router.delete("/deleteProduct/:id", Auth, authorizeRoles("Owner"), deleteProduct);

/* ================= PRODUCT BOOKING ================= */
router.get("/getAllProductBooking", Auth, getAllProductBooking);
router.put("/productBookingUpdate/:id", Auth, productBookingUpdate);
router.put("/productBookingCancel/:id", Auth, productBookingCancel);
// 🔒 Completion (active → completed) is admin/owner-only — the rating gate.
// Customers can never mark a product booking completed themselves.
router.put(
  "/admin/productBooking/:id/complete",
  Auth,
  authorizeRoles("Owner"),
  adminCompleteProductBooking
);

/* ================= PAYMENT ================= */
router.post("/payment/order", Auth, createPaymentOrder);
router.post("/payment/verify", Auth, verifyPayment);
router.post("/payment/webhook/razorpay", razorpayWebhook);
// RBAC: only Admin/Owner may mutate payment state by hand (audited)
router.put("/payment/:id/status", Auth, authorizeRoles("Owner"), updatePaymentStatus);
router.get("/payment/:bookingId", Auth, getPaymentByBooking);

// ✅ Manual retry for stuck settlements (Admin/Owner)
router.post("/payment/retry-settlement", Auth, authorizeRoles("Owner"), retryPaymentSettlement);

/* ================= CART ================= */
router.post("/cart/add", Auth, addToCart);
router.get("/cart/my-cart", Auth, getMyCart);
router.get("/cart/:id", Auth, getCartById);
router.put("/cart/update", Auth, updateCartItem);
router.put("/cart/:id", Auth, updateCartById);
router.post("/cart/set-schedule", Auth, setCartItemSchedule);
router.delete("/cart/remove/:id", Auth, removeFromCart);

// 🔒 Any logged-in user may read/delete a cart item — but only their OWN cart.
// Ownership enforced inside the controllers (cart.customerId === req.user.userId).
router.get("/carts/:id", Auth, getCartByIdUnrestricted);
router.delete("/cart/removed/:id", Auth, removeFromCartUnrestricted);

/* ================= CHECKOUT ================= */
router.post("/checkout", Auth, checkout);

export default router;