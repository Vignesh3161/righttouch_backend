import express from "express";
import {
  changePassword,
  // createPassword,
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
  service,
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
  product,
  getProduct,
  getOneProduct,
  deleteProduct,
  updateProduct
} from "../Controller/productController.js"

import {
  productBooking,
  getAllProductBooking,
  productBookingUpdate,
  productBookingCancel,
} from "../Controller/productBooking.js";

import { Auth } from "../Middleware/Auth.js";
import { authorizeRoles } from"../Middleware/Auth.js";

const router = express.Router();

router.post("/signup", signupAndSendOtp);
router.post("/login", login);
router.post("/resendOtp", resendOtp);
router.post("/verify-otp", verifyOtp);
// router.post("/create-password", createPassword);
router.put("/update-user/:id", updateUser);
router.get("/getallusers", Auth,authorizeRoles('Owner'), getAllUsers);
router.get("/getuserbyid/:id", getUserById);
router.get("/getMyProfile", Auth, getMyProfile);

router.put("/changepassword", Auth, changePassword);
router.post("/requestPasswordResetOtp", Auth, requestPasswordResetOtp);
router.post("/verifyPasswordResetOtp", Auth, verifyPasswordResetOtp);
router.post("/resetPassword", Auth, resetPassword);

// ******category**********
router.post("/category", Auth, serviceCategory);
router.get("/getAllcategory", getAllCategory);
router.get("/getByIdcategory/:id", getByIdCategory);
router.put("/updatecategory/:id", updateCategory);
router.delete("/deletecategory/:id", deleteCategory);
// ******category end**********

// ******report**********
router.post("/report", Auth, userReport);
router.get("/getAllReports", getAllReports);
router.get("/getReportById/:id", getReportById);
// ******report end**********

// ******service**********
router.post("/service", Auth, service);
router.get("/getAllServices", getAllServices);
router.get("/getServiceById/:id", getServiceById);
router.put("/updateService/:id", updateService);
router.delete("/deleteService/:id", deleteService);
// ******service end**********

// *********Service Book***********
router.post("/serviceBook", serviceBook);
router.get("/getAllServiceBooking", getAllServiceBooking);
router.put("/serviceBookUpdate/:id", serviceBookUpdate);
router.put("/serviceBookingCancel/:id", serviceBookingCancel);

// *********Service Book end***********

// ******rating**********
router.post("/rating", Auth, userRating);
router.get("/getAllRatings", getAllRatings);
router.get("/getRatingById/:id", getRatingById);
router.put("/updateRating/:id", updateRating);
router.delete("/deleteRating/:id", deleteRating);
// ******rating end**********

// ******product**********
router.post("/product", product);
router.get("/getProduct", getProduct);
router.get("/getOneProduct/:id", getOneProduct);
router.put("/updateProduct/:id", updateProduct);
router.delete("/deleteProduct/:id", deleteProduct);
// ******product end**********

// *********product Book***********
router.post("/productBooking", productBooking);
router.get("/getAllProductBooking", getAllProductBooking);
router.put("/productBookingUpdate/:id", productBookingUpdate);
router.put("/productBookingCancel/:id", productBookingCancel);

// *********product Book end***********

export default router;
