import Razorpay from "razorpay";
import https from "node:https";

/* =========================
   CONFIG & VALIDATION
========================= */

const getRazorpayXKeys = () => {
    const key_id = process.env.RAZORPAY_X_KEY_ID;
    const key_secret = process.env.RAZORPAY_X_KEY_SECRET;

    if (!key_id || !key_secret) {
        throw new Error("Razorpay X keys not configured");
    }

    return { key_id, key_secret };
};

const resolveSourceAccountNumber = () => {
    const accountNumber = process.env.RAZORPAY_X_ACCOUNT_NUMBER;

    if (!accountNumber) {
        throw new Error("Missing RAZORPAY_X_ACCOUNT_NUMBER");
    }

    if (!/^\d{12,20}$/.test(accountNumber)) {
        throw new Error("Invalid RazorpayX account number");
    }

    return accountNumber;
};

/* =========================
   CORE REQUEST FUNCTION
========================= */

const razorpayXRequest = async ({ method, path, body, referenceId }) => {
    const { key_id, key_secret } = getRazorpayXKeys();
    const payload = body ? JSON.stringify(body) : "";

    const options = {
        hostname: "api.razorpay.com",
        path,
        method,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            Authorization:
                "Basic " + Buffer.from(`${key_id}:${key_secret}`).toString("base64"),
            "X-Payout-Idempotency": referenceId || Date.now().toString(),
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (resp) => {
            let data = "";

            resp.on("data", (chunk) => (data += chunk));

            resp.on("end", () => {
                let json = {};
                try {
                    json = data ? JSON.parse(data) : {};
                } catch {
                    json = { raw: data };
                }

                if (resp.statusCode >= 200 && resp.statusCode < 300) {
                    return resolve(json);
                }

                const err = new Error(
                    json?.error?.description || "Razorpay X request failed"
                );
                err.statusCode = resp.statusCode;
                err.error = json;
                return reject(err);
            });
        });

        // ⏱ Abort hung upstream calls (10s) instead of pinning a worker.
        req.setTimeout(10000, () => {
            const err = new Error("Razorpay X request timed out");
            err.statusCode = 504;
            req.destroy(err);
        });

        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
};

/* =========================
   CONTACT SERVICE
========================= */

export const createOrGetContact = async ({
    existingContactId,
    name,
    email,
    contact,
    referenceId,
}) => {
    if (existingContactId) return existingContactId;

    const body = {
        name,
        type: "vendor",
        reference_id: referenceId,
        email,
        contact,
    };

    const result = await razorpayXRequest({
        method: "POST",
        path: "/v1/contacts",
        body,
    });

    return result.id;
};

// Backward-compatible export expected by admin wallet controller
export const createRazorpayContact = async ({
    name,
    email,
    contact,
    referenceId,
}) =>
    createOrGetContact({
        existingContactId: null,
        name,
        email,
        contact,
        referenceId,
    });

/* =========================
   FUND ACCOUNT SERVICE
========================= */

export const createOrGetFundAccount = async ({
    existingFundAccountId,
    contactId,
    bankDetails,
}) => {
    if (existingFundAccountId) return existingFundAccountId;

    let body;

    if (bankDetails.upiId) {
        body = {
            contact_id: contactId,
            account_type: "vpa",
            vpa: {
                address: bankDetails.upiId,
            },
        };
    } else if (bankDetails.accountNumber && bankDetails.ifscCode) {
        body = {
            contact_id: contactId,
            account_type: "bank_account",
            bank_account: {
                name: bankDetails.accountName || "Technician",
                ifsc: bankDetails.ifscCode,
                account_number: bankDetails.accountNumber,
            },
        };
    } else {
        throw new Error("Invalid bank details");
    }

    const result = await razorpayXRequest({
        method: "POST",
        path: "/v1/fund_accounts",
        body,
    });

    return result.id;
};
/* =========================
   PAYOUT SERVICE
========================= */

export const fetchPayout = async (payoutId) =>
    razorpayXRequest({
        method: "GET",
        path: `/v1/payouts/${payoutId}`,
    });

// Razorpay X payout statuses that mean the money moved out of the platform
export const PAYOUT_SUCCESS_STATUSES = ["sent", "processed"];
// Statuses that mean the payout will never complete
export const PAYOUT_FINAL_FAILURE_STATUSES = ["failed", "cancelled", "reversed", "returned", "bounced"];

export const createPayout = async ({
    fundAccountId,
    amountInPaisa,
    mode = "IMPS",
    referenceId,
    narration = "Technician Payout",
}) => {
    const sourceAccountNumber = resolveSourceAccountNumber();

    // Validation
    if (!amountInPaisa || amountInPaisa < 100) {
        throw new Error("Minimum payout ₹1 (100 paisa)");
    }

    const validModes = ["UPI", "NEFT", "IMPS", "RTGS"];
    if (!validModes.includes(mode)) {
        throw new Error("Invalid payout mode");
    }

    const body = {
        account_number: sourceAccountNumber,
        fund_account_id: fundAccountId,
        amount: amountInPaisa,
        currency: "INR",
        mode,
        purpose: "payout",
        reference_id: referenceId,
        narration,
        queue_if_low_balance: true,
    };

    const result = await razorpayXRequest({
        method: "POST",
        path: "/v1/payouts",
        body,
        referenceId,
    });

    return result;
};