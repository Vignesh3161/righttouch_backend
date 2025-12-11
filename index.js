import express from "express";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
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
  res.setTimeout(60000, () => { // 60 seconds
    console.log("⏳ Request timed out");
    return res.status(408).json({ message: "Request timeout" });
  });
  next();
});

mongoose.set("strictQuery", false);

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB Atlas...'))
.catch(err => console.error('Could not connect to MongoDB...', err));

App.get("/", (req, res) => {
  res.send("welcome");
});

// Routes
App.use('/api/user', UserRoutes);
App.use('/api/technician', TechnicianRoutes);

const port = process.env.PORT || 7372;
App.listen(port, () => {
  console.log("Server connected to " + port);
});
