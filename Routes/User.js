import express from "express";
import { upload } from "../Utils/cloudinaryUpload.js";
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
  updateRating,
  deleteRating,
  getMyRatings,
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
  getCustomerBookings,
  cancelBooking,
  getCancellationReasons,
  deleteAllCustomerBookings,
  getOwnerAllBookings,
  getOwnerBookingById,
  getCompletedServices,
  rebookService,
} from "../Controllers/serviceBookController.js";


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
  productBooking,
  getAllProductBooking,
  productBookingUpdate,
  productBookingCancel,
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


// ================= UNIFIED OTP LOGIN (ALL ROLES) =================
// Use a single endpoint for all roles, DRY and secure
router.post("/auth/login/request-otp", requestLoginOtp);
router.post("/auth/login/verify-otp", verifyLoginOtp);
router.post("/auth/accept-terms", Auth, acceptTerms);
router.delete("/delete-my-account", Auth, deleteMyAccount);

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
router.post("/signup/customer/verify-otp", authLimiter, verifyOtp);

/* ================= USER LOGIN ROUTES (Role-specific) ================= */
// Customer login (default, only allows Customer role)
router.post("/login/customer", authLimiter, async (req, res, next) => {
  req.body = req.body || {};
  req.body.role = "Customer";
  return login(req, res, next);
});

// Customer: verify OTP (role pre-filled)
router.post("/login/customer/verify-otp", authLimiter, verifyOtp);


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
router.post("/owner/verify-otp", authLimiter, async (req, res, next) => {
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
router.get("/getReportById/:id", Auth, getReportById);
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

/* ================= BOOK AGAIN ================= */
router.get("/booking/completed-services", Auth, getCompletedServices);
router.post("/booking/book-again", Auth, rebookService);


/* ================= OWNER BOOKING MANAGEMENT ================= */
router.get("/booking/getAllBookings", Auth, authorizeRoles("Admin", "Owner"), getOwnerAllBookings);
router.get("/booking/getBookingById/:id", Auth, authorizeRoles("Admin", "Owner"), getOwnerBookingById);

/* ================= RATING ================= */
router.post("/rating", Auth, userRating);
// 🔒 Authenticated browsing only — no anonymous scraping of user ratings
router.get("/getAllRatings", Auth, getAllRatings);
router.get("/getRatingById/:id", Auth, getRatingById);
router.put("/updateRating/:id", Auth, updateRating);
router.delete("/deleteRating/:id", Auth, deleteRating);
router.get("/get-my-ratings", Auth, getMyRatings);

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