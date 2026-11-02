import "dotenv/config";
import mongoose from "mongoose";
import Cart from "../Schemas/Cart.js";
import User from "../Schemas/User.js";
import Product from "../Schemas/Product.js";
import Address from "../Schemas/Address.js";
import ProductQuoteRequest from "../Schemas/ProductQuoteRequest.js";
import { generateRequestNumber } from "../Utils/quotationNumber.js";

const parseArgs = (argv) => {
  const args = { apply: false, help: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
};

const usage = () => {
  console.log(`Usage: node scripts/migrateProductCartToQuoteRequests.js [options]

Converts legacy product cart items into single-product quote requests and then
removes them from the cart. Safe to re-run.

Options:
  --apply   Apply the migration. Without this flag the script is a dry run.
  --help    Show this message.`);
};

const ACTIVE_REQUEST_STATUSES = [
  "quote_requested",
  "under_review",
  "quotation_prepared",
  "quotation_sent",
  "viewed",
  "expired",
  "rejected",
];

const newRequestNumber = async () => {
  for (let i = 0; i < 5; i += 1) {
    const requestNumber = generateRequestNumber();
    if (!(await ProductQuoteRequest.exists({ requestNumber }))) return requestNumber;
  }
  throw new Error("Unable to allocate a unique request number");
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  const items = await Cart.find({ itemType: "product" }).lean();
  console.log(`[migrate] ${args.apply ? "Applying" : "Dry run:"} ${items.length} product cart item(s)`);

  if (!args.apply || items.length === 0) {
    for (const item of items.slice(0, 20)) {
      console.log(`  customer=${item.customerId} product=${item.itemId} qty=${item.quantity}`);
    }
    if (items.length > 20) console.log(`  ... and ${items.length - 20} more`);
    return;
  }

  let created = 0;
  let reused = 0;
  let failed = 0;
  const migratedCartItemIds = [];

  for (const item of items) {
    try {
      const existing = await ProductQuoteRequest.findOne({
        customerId: item.customerId,
        productId: item.itemId,
        status: { $in: ACTIVE_REQUEST_STATUSES },
      });
      if (!existing) {
        const [customer, product, address] = await Promise.all([
          User.findById(item.customerId).select("fname lname mobileNumber email").lean(),
          Product.findById(item.itemId).lean(),
          Address.findOne({ customerId: item.customerId }).sort({ createdAt: -1 }).lean(),
        ]);

        if (!product) {
          failed += 1;
          continue;
        }

        await ProductQuoteRequest.create({
          requestNumber: await newRequestNumber(),
          customerId: item.customerId,
          productId: item.itemId,
          customerSnapshot: {
            name: address?.name || [customer?.fname, customer?.lname].filter(Boolean).join(" ").trim(),
            phone: address?.phone || customer?.mobileNumber,
            email: customer?.email,
          },
          productSnapshot: {
            productName: product.productName,
            productType: product.productType,
            imageUrl: product.productImages?.[0] || null,
          },
          quantity: item.quantity || 1,
          locationType: "saved",
          addressSnapshot: address ? {
            addressLine: address.addressLine,
            city: address.city,
            state: address.state,
            pincode: address.pincode,
            name: address.name,
            phone: address.phone,
            latitude: address.latitude,
            longitude: address.longitude,
          } : undefined,
          status: "quote_requested",
        });
        created += 1;
      } else {
        reused += 1;
      }
      migratedCartItemIds.push(item._id);
    } catch (err) {
      failed += 1;
      console.error(`[migrate] failed customer=${item.customerId} product=${item.itemId}: ${err.message}`);
    }
  }

  const removed = await Cart.deleteMany({ _id: { $in: migratedCartItemIds } });
  console.log(`[migrate] created=${created} reused=${reused} failed=${failed} removedCartItems=${removed.deletedCount}`);
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
