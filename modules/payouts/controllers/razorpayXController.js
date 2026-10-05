import {
  createOrGetContact,
  createOrGetFundAccount,
  createPayout as createRazorpayXPayout,
} from "../utils/razorpayX.js";

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

export const createFundAccount = async ({ contactId, bankDetails }) =>
  createOrGetFundAccount({
    existingFundAccountId: null,
    contactId,
    bankDetails,
  });

export const createPayout = async (params) => createRazorpayXPayout(params);
