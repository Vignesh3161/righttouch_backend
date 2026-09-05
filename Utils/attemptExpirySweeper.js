import PaymentAttempt from "../Schemas/PaymentAttempt.js";
import { expireStaleAttempts } from "./paymentAttempts.js";

let timer = null;

/** Marks stale `created` attempts as `expired` so retry is unblocked (R6). */
export const startAttemptExpirySweeper = () => {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const n = await expireStaleAttempts();
      if (n > 0) console.log(`⏰ expired ${n} stale payment attempt(s)`);
    } catch (e) {
      console.error("attemptExpirySweeper error:", e.message);
    }
  }, 60 * 1000);
  timer.unref?.();
};

export const stopAttemptExpirySweeper = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
