import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { Server } from "socket.io";
import UserRoutes from "./Routes/User.js";
import TechnicianRoutes from "./Routes/technician.js";
import AddressRoutes from "./Routes/address.js";
import adminWalletRoutes from "./Routes/adminWalletRoutes.js";
import technicianWalletRoutes from "./Routes/technicianWalletRoutes.js";
import DevRoutes from "./Routes/dev.js";
// ENV
dotenv.config();

const app = express();

// BASIC MIDDLEWARES
app.use(cors());
app.use(helmet());

app.use(express.json());

// RATE LIMIT
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
});

app.use(limiter);

// MONGODB
mongoose.set("strictQuery", false);

mongoose
  .connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  })
  .then(() => {
    console.log("✅ MongoDB Connected");
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err);
  });

// ROOT API
app.get("/", (req, res) => {
  res.send("Cloud Run Working");
});

app.use("/api/user", UserRoutes);
app.use("/api/technician", TechnicianRoutes);
app.use("/api/technician", technicianWalletRoutes);
app.use("/api/addresses", AddressRoutes);
app.use("/api/admin", adminWalletRoutes);
app.use("/api/dev", DevRoutes);

// HTTP SERVER
const httpServer = createServer(app);

// SOCKET.IO SIMPLE SETUP
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("🔌 Socket Connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("🔌 Socket Disconnected:", socket.id);
  });
});

// START SERVER
const port = process.env.PORT || 8080;

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${port}`);
});