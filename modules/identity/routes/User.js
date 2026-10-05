import express from "express";
import { upload } from "../../../shared/utils/cloudinaryUpload.js";
import rateLimit from 'express-rate-limit';
import {
  signupAndSendOtp,
  resendOtp,
  verifyOtp,
  setPassword,
  login,
  technicianLogin,
  ownerLogin,
  refreshSession,
  logout,
  logoutAll,
  getMyProfile,
  completeProfile,
  updateMyProfile,
  getUserById,
  getAllUsers,
  deleteUserById,
  provisionAdmin,
  checkUserByIdentifier,
  requestLoginOtp,
  verifyLoginOtp,
  acceptTerms,
} from "../controllers/User.js";

import { deleteMyAccount } from "../controllers/accountController.js";

// ...existing code...



import {
  serviceCategory,
  uploadCategoryImage,
  removeCategoryImage,
  getAllCategory,
  getByIdCategory,
  updateCategory,
  deleteCategory,
} from "../../catalog/controllers/categoryController.js";

import {
  userRating,
  getAllRatings,
  getRatingById,
  updateRatingController,
  deleteRatingController,
  getMyRatings,
  rebuildAggregateController,
} from "../../support-system/controllers/ratingController.js";

import {
  userReport,
  getAllReports,
  getReportById,
  getMyReports,
  resolveReport,
} from "../../support-system/controllers/reportController.js";

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
} from "../../catalog/controllers/serviceController.js";

import {
  createBooking,
  getBookings,
  getBookingSchedule,
  storeBookingSchedule,
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
} from "../../booking/controllers/serviceBookController.js";


import {
  createProduct,
  getProduct,
  getOneProduct,
  deleteProduct,
  uploadProductImages,
  removeProductImage,
  replaceProductImages,
  updateProduct,
} from "../../catalog/controllers/productController.js";

import {
  getAllProductBooking,
  productBookingUpdate,
  productBookingCancel,
  adminCompleteProductBooking,
} from "../../quote-product/controllers/productBooking.js";

import {
  createPaymentOrder,
  verifyPayment,
  razorpayWebhook,
  updatePaymentStatus,
  retryPaymentSettlement,
  getPaymentByBooking,
} from "../../payments/controllers/paymentController.js";

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
} from "../../cart-address/controllers/cartController.js";

import { Auth } from "../../../shared/middleware/Auth.js";


const router = express.Router();

const getClientIp = (req) => {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
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
});

// ================= UNIFIED OTP LOGIN (ALL ROLES) =================
// Use a single endpoint for all roles, DRY and secure
// P0: route-level limiter added (same authLimiter mechanism/shape as other
// auth routes; success contract unchanged — denial is the existing
// {success:false,message,result:{}} shape).
router.post("/auth/login/request-otp", authLimiter, requestLoginOtp);
router.post("/auth/login/verify-otp", authLimiter, verifyLoginOtp);
router.post("/auth/accept-terms", Auth, acceptTerms);
// P5 — persistent sessions (centralized identity routes; no per-role
// duplicates). Refresh is public (the refresh token is the credential);
// logout/logout-all derive the user from the verified access token.
router.post("/auth/refresh", authLimiter, refreshSession);
router.post("/auth/logout", Auth, logout);
router.post("/auth/logout-all", Auth, logoutAll);
router.delete("/delete-my-account", Auth, deleteMyAccount);

/* ================= USER ================= */
router.post("/signup", authLimiter, signupAndSendOtp);
router.post("/resend-otp", otpLimiter, resendOtp);
router.post("/verify-otp", authLimiter, verifyOtp);
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
// P2: server-trusted OTP scope — this route only ever consumes
// Customer SIGNUP OTPs (Task 1/2).
router.post("/signup/customer/verify-otp", authLimiter, (req, res, next) => {
  req.otpScope = { role: "Customer", purpose: "SIGNUP" };
  return verifyOtp(req, res, next);
});

/* ================= USER LOGIN ROUTES (Role-specific) ================= */
// Customer login (default, only allows Customer role)
router.post("/login/customer", authLimiter, async (req, res, next) => {
  req.body = req.body || {};
  req.body.role = "Customer";
  return login(req, res, next);
});

// Customer: verify OTP (role pre-filled)
// P2: server-trusted OTP scope — Customer LOGIN OTPs only.
router.post("/login/customer/verify-otp", authLimiter, (req, res, next) => {
  req.otpScope = { role: "Customer", purpose: "LOGIN" };
  return verifyOtp(req, res, next);
});


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
// P2: server-trusted OTP scope — Owner SIGNUP OTPs only.
router.post("/owner/verify-otp", authLimiter, async (req, res, next) => {
  // req.body.role = "Owner";
  req.otpScope = { role: "Owner", purpose: "SIGNUP" };
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
import { authorizeRoles } from "../../../shared/middleware/Auth.js";
router.get("/debug/check-user/:identifier", Auth, authorizeRoles("Owner", "Admin"), checkUserByIdentifier);

router.get("/me", Auth, getMyProfile);
router.post("/complete-profile", Auth, completeProfile);
router.put("/me", Auth, updateMyProfile);
// 🔒 Admin/Owner only — user PII & account management
router.get("/users/:role/:id", Auth, authorizeRoles("Admin", "Owner"), getUserById);
router.get("/users/:role", Auth, authorizeRoles("Admin", "Owner"), getAllUsers);
// P1 (Task 4): Owner-only Admin provisioning. Additive route — public Admin
// signup stays disabled; no /signup/admin is introduced.
router.post("/users", Auth, authorizeRoles("Owner"), provisionAdmin);
router.delete("/users/:id", Auth, authorizeRoles("Owner"), deleteUserById);

/* ================= CATEGORY ================= */
router.post("/category", Auth, authorizeRoles("Admin", "Owner"), serviceCategory);
router.post(
  "/category/upload-image",
  Auth,
  authorizeRoles("Admin", "Owner"),
  upload.single("image"),
  uploadCategoryImage
);
router.delete("/category/remove-image", Auth, authorizeRoles("Admin", "Owner"), removeCategoryImage);
router.get("/getAllcategory", getAllCategory);
router.get("/getByIdcategory/:id", getByIdCategory);
router.put("/updatecategory/:id", Auth, authorizeRoles("Admin", "Owner"), updateCategory);
router.delete("/deletecategory/:id", Auth, authorizeRoles("Admin", "Owner"), deleteCategory);

/* ================= REPORT ================= */
router.post("/report", Auth, userReport);
router.get("/getAllReports", Auth, authorizeRoles("Admin", "Owner"), getAllReports);
router.get("/get-my-reports", Auth, getMyReports);
router.get("/getReportById/:id", Auth, authorizeRoles("Admin", "Owner"), getReportById);
router.put("/report/resolve/:id", Auth, authorizeRoles("Admin", "Owner"), resolveReport);

/* ================= SERVICE ================= */
router.post("/service", Auth, authorizeRoles("Admin", "Owner"), createService);
router.post(
  "/services/upload-images",
  Auth,
  authorizeRoles("Admin", "Owner"),
  upload.array("serviceImages", 5),
  uploadServiceImages
);
router.delete("/services/remove-image", Auth, authorizeRoles("Admin", "Owner"), removeServiceImage);
router.put(
  "/services/replace-images",
  Auth,
  authorizeRoles("Admin", "Owner"),
  upload.array("serviceImages", 5),
  replaceServiceImages
);
router.get("/getAllServices", getAllServices);
router.get("/getServiceById/:id", getServiceById);
router.put("/updateService/:id", Auth, authorizeRoles("Admin", "Owner"), updateService);
router.put("/service/:id/zone-restriction", Auth, authorizeRoles("Admin", "Owner"), toggleZoneRestriction);
router.delete("/services/:id", Auth, authorizeRoles("Admin", "Owner"), deleteService);

/* ================= SERVICE COVERAGE POLYGON (Admin/Owner) ================= */
// Polygon = where the service can be booked + where technicians get matched
router.get("/service/:id/polygon", Auth, getServicePolygon);
router.put("/service/:id/polygon", Auth, setServicePolygon);
router.delete("/service/:id/polygon", Auth, removeServicePolygon);

/* ================= SERVICE BOOKING ================= */
router.get("/service/booking", Auth, getBookings);
router.get("/booking/slots", getBookingSchedule);
router.post("/booking/schedule", Auth, storeBookingSchedule);
router.put("/booking/cancel/:id", Auth, cancelBooking);
router.get("/booking/reasons", Auth, getCancellationReasons);
router.get("/booking/getCustomerBookings", Auth, getCustomerBookings);
router.delete("/booking/deleteAll", Auth, deleteAllCustomerBookings);
router.delete("/booking/:id", Auth, deleteServiceBooking);
router.delete("/booking/admin/:id", Auth, authorizeRoles("Admin", "Owner"), deleteBookingAsAdmin);

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

/* ================= PRODUCT ================= */
router.post("/product", Auth, authorizeRoles("Admin", "Owner"), createProduct);
router.post(
  "/product/upload-images",
  Auth,
  authorizeRoles("Admin", "Owner"),
  upload.array("productImages", 5),
  uploadProductImages
);
router.delete("/product/remove-image", Auth, authorizeRoles("Admin", "Owner"), removeProductImage);
router.put(
  "/product/replace-images",
  Auth,
  authorizeRoles("Admin", "Owner"),
  upload.array("productImages", 5),
  replaceProductImages
);
router.get("/getProduct", getProduct);
router.get("/getOneProduct/:id", getOneProduct);
router.put(
  "/updateProduct/:id",
  Auth,
  authorizeRoles("Admin", "Owner"),
  upload.array("productImages", 5),
  updateProduct
);
router.delete("/deleteProduct/:id", Auth, authorizeRoles("Admin", "Owner"), deleteProduct);

/* ================= PRODUCT BOOKING ================= */
router.get("/getAllProductBooking", Auth, getAllProductBooking);
router.put("/productBookingUpdate/:id", Auth, productBookingUpdate);
router.put("/productBookingCancel/:id", Auth, productBookingCancel);
// 🔒 Completion (active → completed) is admin/owner-only — the rating gate.
// Customers can never mark a product booking completed themselves.
router.put(
  "/admin/productBooking/:id/complete",
  Auth,
  authorizeRoles("Admin", "Owner"),
  adminCompleteProductBooking
);

/* ================= PAYMENT ================= */
router.post("/payment/order", Auth, createPaymentOrder);
router.post("/payment/verify", Auth, verifyPayment);
router.post("/payment/webhook/razorpay", razorpayWebhook);
// RBAC: only Admin/Owner may mutate payment state by hand (audited)
router.put("/payment/:id/status", Auth, authorizeRoles("Admin", "Owner"), updatePaymentStatus);
router.get("/payment/:bookingId", Auth, getPaymentByBooking);

// ✅ Manual retry for stuck settlements (Admin/Owner)
router.post("/payment/retry-settlement", Auth, retryPaymentSettlement);

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