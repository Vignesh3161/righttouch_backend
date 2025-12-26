import express from "express";
import { upload } from "../utils/cloudinaryUpload.js";

import {
  changePassword,
  getAllUsers,
  getMyProfile,
  getUserById,
  login,
  resendOtp,
  requestPasswordResetOtp,
  resetPassword,
  signupAndSendOtp,
  updateUser,
  verifyOtp,
  verifyPasswordResetOtp,
} from "../Controller/User.js";

import {
  serviceCategory,
  uploadCategoryImage,
  getAllCategory,
  getByIdCategory,
  updateCategory,
  deleteCategory,
} from "../Controller/categoryController.js";

import {
  userRating,
  getAllRatings,
  getRatingById,
  updateRating,
  deleteRating,
} from "../Controller/ratingController.js";

import {
  userReport,
  getAllReports,
  getReportById,
} from "../Controller/reportController.js";

import {
  createService,
  uploadServiceImages,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
} from "../Controller/serviceController.js";

import {
  serviceBook,
  getAllServiceBooking,
  serviceBookUpdate,
  serviceBookingCancel,
} from "../Controller/serviceBookController.js";

import {
  createProduct,
  getProduct,
  getOneProduct,
  deleteProduct,
  uploadProductImages,
  updateProduct,
} from "../Controller/productController.js";

import {
  productBooking,
  getAllProductBooking,
  productBookingUpdate,
  productBookingCancel,
} from "../Controller/productBooking.js";

import { Auth, authorizeRoles } from "../Middleware/Auth.js";

const router = express.Router();

/* ================= USER ================= */
router.post("/signup", signupAndSendOtp);
router.post("/login", login);
router.post("/resendOtp", resendOtp);
router.post("/verify-otp", verifyOtp);
router.put("/update-user/:id", updateUser);
router.get("/getallusers", Auth, getAllUsers);
router.get("/getuserbyid/:id", getUserById);
router.get("/getMyProfile", Auth, getMyProfile);
router.post("/requestPasswordResetOtp", requestPasswordResetOtp);
router.post("/verifyPasswordResetOtp", verifyPasswordResetOtp);
router.put("/changepassword", Auth, changePassword);
router.post("/resetPassword", Auth, resetPassword);

/* ================= CATEGORY ================= */

router.post("/category", Auth, serviceCategory);
router.post(
  "/category/upload-image",
  Auth,
  upload.single("image"),
  uploadCategoryImage
);
router.get("/getAllcategory", getAllCategory);
router.get("/getByIdcategory/:id", getByIdCategory);
router.put("/updatecategory/:id", Auth, updateCategory);
router.delete("/deletecategory/:id", Auth, deleteCategory);

/* ================= REPORT ================= */

router.post("/report", Auth, userReport);
router.get("/getAllReports", getAllReports);
router.get("/getReportById/:id", getReportById);

/* ================= SERVICE ================= */

router.post("/service", Auth, createService);
router.post(
  "/services/upload-images",
  Auth,
  upload.array("serviceImages", 5),
  uploadServiceImages
);
router.get("/getAllServices", getAllServices);
router.get("/getServiceById/:id", getServiceById);
router.put("/updateService/:id", Auth, updateService);
router.delete("/services/:id", Auth, deleteService);

/* ================= SERVICE BOOKING ================= */

router.post("/serviceBook", serviceBook);
router.get("/getAllServiceBooking", getAllServiceBooking);
router.put("/serviceBookUpdate/:id", serviceBookUpdate);
router.put("/serviceBookingCancel/:id", serviceBookingCancel);

/* ================= RATING ================= */

router.post("/rating", Auth, userRating);
router.get("/getAllRatings", getAllRatings);
router.get("/getRatingById/:id", getRatingById);
router.put("/updateRating/:id", updateRating);
router.delete("/deleteRating/:id", deleteRating);

/* ================= PRODUCT ================= */

router.post("/product", Auth, createProduct);
router.post(
  "/product/upload-images",
  Auth,
  upload.array("productImages", 5),
  uploadProductImages
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

router.post("/productBooking", productBooking);
router.get("/getAllProductBooking", getAllProductBooking);
router.put("/productBookingUpdate/:id", productBookingUpdate);
router.put("/productBookingCancel/:id", productBookingCancel);

export default router;
