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
  req.body.role = "Customer";
  // termsAccepted must be sent in body
  return signupAndSendOtp(req, res, next);
});

// Customer: verify OTP after signup
router.post("/signup/customer/verify-otp", authLimiter, verifyOtp);

/* ================= USER LOGIN ROUTES (Role-specific) ================= */
// Customer login (default, only allows Customer role)
router.post("/login/customer", authLimiter, async (req, res, next) => {
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
router.get("/users/:role/:id", getUserById);
router.get("/users/:role", getAllUsers);
router.delete("/users/:id", deleteUserById);

/* ================= CATEGORY ================= */
router.post("/category", Auth, serviceCategory);
router.post(
  "/category/upload-image",
  Auth,
  upload.single("image"),
  uploadCategoryImage
);
router.delete("/category/remove-image", Auth, removeCategoryImage);
router.get("/getAllcategory", getAllCategory);
router.get("/getByIdcategory/:id", getByIdCategory);
router.put("/updatecategory/:id", Auth, updateCategory);
router.delete("/deletecategory/:id", Auth, deleteCategory);

/* ================= REPORT ================= */
router.post("/report", Auth, userReport);
router.get("/getAllReports", getAllReports);
router.get("/get-my-reports", Auth, getMyReports);
router.get("/getReportById/:id", Auth, getReportById);
router.put("/report/resolve/:id", Auth, resolveReport);

/* ================= SERVICE ================= */
router.post("/service", Auth, createService);
router.post(
  "/services/upload-images",
  Auth,
  upload.array("serviceImages", 5),
  uploadServiceImages
);
router.delete("/services/remove-image", removeServiceImage);
router.put(
  "/services/replace-images",
  Auth,
  upload.array("serviceImages", 5),
  replaceServiceImages
);
router.get("/getAllServices", getAllServices);
router.get("/getServiceById/:id", getServiceById);
router.put("/updateService/:id", Auth, updateService);
router.delete("/services/:id", Auth, deleteService);

/* ================= SERVICE BOOKING ================= */
router.get("/service/booking", Auth, getBookings);
router.get("/booking/slots", getBookingSchedule);
router.post("/booking/schedule", Auth, storeBookingSchedule);
router.put("/booking/cancel/:id", Auth, cancelBooking);
router.get("/booking/reasons", Auth, getCancellationReasons);
router.get("/booking/getCustomerBookings", Auth, getCustomerBookings);
router.delete("/booking/deleteAll", Auth, deleteAllCustomerBookings);

/* ================= OWNER BOOKING MANAGEMENT ================= */
router.get("/booking/getAllBookings", getOwnerAllBookings);
router.get("/booking/getBookingById/:id", getOwnerBookingById);

/* ================= RATING ================= */
router.post("/rating", Auth, userRating);
router.get("/getAllRatings", getAllRatings);
router.get("/getRatingById/:id", getRatingById);
router.put("/updateRating/:id", Auth, updateRating);
router.delete("/deleteRating/:id", Auth, deleteRating);
router.get("/get-my-ratings", Auth, getMyRatings);

/* ================= PRODUCT ================= */
router.post("/product", Auth, createProduct);
router.post(
  "/product/upload-images",
  Auth,
  upload.array("productImages", 5),
  uploadProductImages
);
router.delete("/product/remove-image", Auth, removeProductImage);
router.put(
  "/product/replace-images",
  Auth,
  upload.array("productImages", 5),
  replaceProductImages
);
router.get("/getProduct", getProduct);
router.get("/getOneProduct/:id", getOneProduct);
router.put(
  "/updateProduct/:id",
  Auth,
  upload.array("productImages", 5),
  updateProduct
);
router.delete("/deleteProduct/:id", Auth, deleteProduct);

/* ================= PRODUCT BOOKING ================= */
router.get("/getAllProductBooking", Auth, getAllProductBooking);
router.put("/productBookingUpdate/:id", Auth, productBookingUpdate);
router.put("/productBookingCancel/:id", Auth, productBookingCancel);

/* ================= PAYMENT ================= */
router.post("/payment/order", Auth, createPaymentOrder);
router.post("/payment/verify", Auth, verifyPayment);
router.post("/payment/webhook/razorpay", razorpayWebhook);
router.put("/payment/:id/status", Auth, updatePaymentStatus);

// ✅ New: Manual retry for stuck settlements (Admin/Owner)
router.post("/payment/retry-settlement", Auth, retryPaymentSettlement);

/* ================= CART ================= */
router.post("/cart/add", Auth, addToCart);
router.get("/cart/my-cart", Auth, getMyCart);
router.get("/cart/:id", Auth, getCartById);
router.put("/cart/update", Auth, updateCartItem);
router.put("/cart/:id", Auth, updateCartById);
router.post("/cart/set-schedule", Auth, setCartItemSchedule);
router.delete("/cart/remove/:id", Auth, removeFromCart);

router.get("/carts/:id", getCartByIdUnrestricted);
router.delete("/cart/removed/:id", removeFromCartUnrestricted);

/* ================= CHECKOUT ================= */
router.post("/checkout", Auth, checkout);

export default router;