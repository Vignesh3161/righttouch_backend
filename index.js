import express from "express";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";

import UserRoutes from "./Routes/User.js";
import TechnicianRoutes from "./Routes/technician.js";

dotenv.config();
const App = express();

App.use(express.json());
App.use(cors());
App.use(bodyParser.json());
App.use(bodyParser.urlencoded({ extended: true }));
App.use(express.static("public"));

// 🔥 Global Timeout Middleware (Fix Flutter timeout)
App.use((req, res, next) => {
  res.setTimeout(60000, () => {
    console.log("⏳ Request timed out");
    return res.status(408).json({
      success: false,
      message: "Request timeout",
      result: "Request took too long to process",
    });
  });
  next();
});

mongoose.set("strictQuery", false);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Connected to MongoDB Atlas..."))
  .catch((err) => console.error("Could not connect to MongoDB...", err));

App.get("/", (req, res) => {
  res.send("welcome");
});

// Routes
App.use("/api/user", UserRoutes);
App.use("/api/technician", TechnicianRoutes);

// ❗ GLOBAL ERROR HANDLER (MUST BE LAST)
App.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  return res.status(500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

const port = process.env.PORT || 7372;
App.listen(port, () => {
  console.log("Server connected to " + port);
});
