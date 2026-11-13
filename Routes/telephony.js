import express from "express";
import { twilioStatusWebhook } from "../Controllers/callLogController.js";

const router = express.Router();

router.post(
  "/twilio/status",
  express.urlencoded({ extended: false }),
  twilioStatusWebhook
);

export default router;
