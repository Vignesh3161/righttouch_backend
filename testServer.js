import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const app = express();

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("Mongo Connected"))
.catch(err => console.log(err));

app.get("/", (req, res) => {
  res.send("Mongo Working");
});

const port = process.env.PORT || 8080;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on ${port}`);
});