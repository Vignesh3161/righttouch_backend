import mongoose from "mongoose";
import https from "https";
import dotenv from "dotenv";
import Category from "../Schemas/Category.js";
import Service from "../Schemas/Service.js";
import Product from "../Schemas/Product.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKYC from "../Schemas/TechnicianKYC.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const storageHost = process.env.BUNNY_STORAGE_HOSTNAME || "storage.bunnycdn.com";
const storageZone = process.env.BUNNY_STORAGE_ZONE_NAME;
const apiKey = process.env.BUNNY_STORAGE_API_KEY;
const cdnHost = (process.env.BUNNY_CDN_HOSTNAME || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");

if (!storageZone || !apiKey || !cdnHost) {
  console.error("❌ Please configure BUNNY_STORAGE_ZONE_NAME, BUNNY_STORAGE_API_KEY, and BUNNY_CDN_HOSTNAME in .env first.");
  process.exit(1);
}

/**
 * Downloads a file from an HTTP/HTTPS URL and streams it to Bunny Storage
 */
function transferFileToBunny(sourceUrl, destinationPath) {
  return new Promise((resolve, reject) => {
    const cleanPath = destinationPath.replace(/^\/+/, "");
    const targetUrl = `https://${storageHost}/${storageZone}/${cleanPath}`;

    https.get(sourceUrl, (srcRes) => {
      if (srcRes.statusCode >= 300 && srcRes.statusCode < 400 && srcRes.headers.location) {
        // Handle redirect
        return transferFileToBunny(srcRes.headers.location, destinationPath).then(resolve).catch(reject);
      }

      if (srcRes.statusCode !== 200) {
        return reject(new Error(`Failed to download from ${sourceUrl}: HTTP ${srcRes.statusCode}`));
      }

      const uploadReq = https.request(
        targetUrl,
        {
          method: "PUT",
          headers: {
            AccessKey: apiKey,
            "Content-Type": srcRes.headers["content-type"] || "application/octet-stream",
          },
        },
        (uploadRes) => {
          let respData = "";
          uploadRes.on("data", (c) => (respData += c));
          uploadRes.on("end", () => {
            if (uploadRes.statusCode >= 200 && uploadRes.statusCode < 300) {
              const newUrl = `https://${cdnHost}/${cleanPath}`;
              resolve({ newUrl, cleanPath });
            } else {
              reject(new Error(`Bunny storage returned status ${uploadRes.statusCode}: ${respData}`));
            }
          });
        }
      );

      uploadReq.on("error", reject);
      srcRes.pipe(uploadReq);
    }).on("error", reject);
  });
}

function extractFilenameFromCloudinaryUrl(url, defaultPrefix = "asset") {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1];
    return `${Date.now()}-${lastPart}`;
  } catch {
    return `${Date.now()}-${defaultPrefix}.jpg`;
  }
}

async function runMigration() {
  console.log("🚀 Starting Cloudinary to Bunny.net migration...");
  await mongoose.connect(MONGO_URI);
  console.log(" Connected to MongoDB");

  let migratedCategories = 0;
  let migratedServices = 0;
  let migratedProducts = 0;
  let migratedTechProfiles = 0;
  let migratedKyc = 0;

  // 1. Categories
  const categories = await Category.find({ image: { $regex: "cloudinary.com" } });
  console.log(`\nFound ${categories.length} categories with Cloudinary images`);
  for (const cat of categories) {
    try {
      const filename = extractFilenameFromCloudinaryUrl(cat.image, "category");
      const { newUrl } = await transferFileToBunny(cat.image, `boutique/category/${filename}`);
      cat.image = newUrl;
      await cat.save();
      migratedCategories++;
      console.log(` Category "${cat.category}" migrated -> ${newUrl}`);
    } catch (err) {
      console.error(`❌ Category "${cat.category}" failed:`, err.message);
    }
  }

  // 2. Services
  const services = await Service.find({ "serviceImages.0": { $exists: true } });
  console.log(`\nFound ${services.length} services to check for Cloudinary images`);
  for (const s of services) {
    let updated = false;
    const newImages = [];
    for (const img of s.serviceImages || []) {
      if (typeof img === "string" && img.includes("cloudinary.com")) {
        try {
          const filename = extractFilenameFromCloudinaryUrl(img, "service");
          const { newUrl } = await transferFileToBunny(img, `boutique/category/${filename}`);
          newImages.push(newUrl);
          updated = true;
        } catch (err) {
          console.error(`❌ Service image transfer failed:`, err.message);
          newImages.push(img);
        }
      } else {
        newImages.push(img);
      }
    }
    if (updated) {
      s.serviceImages = newImages;
      await s.save();
      migratedServices++;
      console.log(` Service "${s.serviceName}" images migrated`);
    }
  }

  // 3. Products
  const products = await Product.find({ "productImages.0": { $exists: true } });
  console.log(`\nFound ${products.length} products to check for Cloudinary images`);
  for (const p of products) {
    let updated = false;
    const newImages = [];
    for (const img of p.productImages || []) {
      if (typeof img === "string" && img.includes("cloudinary.com")) {
        try {
          const filename = extractFilenameFromCloudinaryUrl(img, "product");
          const { newUrl } = await transferFileToBunny(img, `boutique/category/${filename}`);
          newImages.push(newUrl);
          updated = true;
        } catch (err) {
          console.error(`❌ Product image transfer failed:`, err.message);
          newImages.push(img);
        }
      } else {
        newImages.push(img);
      }
    }
    if (updated) {
      p.productImages = newImages;
      await p.save();
      migratedProducts++;
      console.log(` Product "${p.productName}" images migrated`);
    }
  }

  // 4. Technician Profiles
  const profiles = await TechnicianProfile.find({ profileImage: { $regex: "cloudinary.com" } });
  console.log(`\nFound ${profiles.length} technician profiles with Cloudinary images`);
  for (const prof of profiles) {
    try {
      const filename = extractFilenameFromCloudinaryUrl(prof.profileImage, "profile");
      const { newUrl } = await transferFileToBunny(prof.profileImage, `boutique/category/${filename}`);
      prof.profileImage = newUrl;
      await prof.save();
      migratedTechProfiles++;
      console.log(` Technician profile ${prof._id} migrated -> ${newUrl}`);
    } catch (err) {
      console.error(`❌ Technician profile ${prof._id} failed:`, err.message);
    }
  }

  // 5. Technician KYC documents
  const kycs = await TechnicianKyc.find({
    $or: [
      { "documents.aadhaarUrl.0": { $exists: true } },
      { "documents.panUrl.0": { $exists: true } },
      { "documents.dlUrl.0": { $exists: true } },
    ],
  });
  console.log(`\nFound ${kycs.length} KYC records to check`);
  for (const kyc of kycs) {
    let updated = false;
    const docFields = ["aadhaarUrl", "panUrl", "dlUrl"];
    for (const field of docFields) {
      const list = kyc.documents?.[field] || [];
      const newList = [];
      for (const item of list) {
        if (typeof item === "string" && item.includes("cloudinary.com")) {
          try {
            const filename = extractFilenameFromCloudinaryUrl(item, field);
            const targetPath = `kyc/documents/${filename}`;
            const { cleanPath } = await transferFileToBunny(item, targetPath);
            newList.push(cleanPath);
            updated = true;
          } catch (err) {
            console.error(`❌ KYC ${field} failed:`, err.message);
            newList.push(item);
          }
        } else {
          newList.push(item);
        }
      }
      if (kyc.documents) {
        kyc.documents[field] = newList;
      }
    }
    if (updated) {
      await kyc.save();
      migratedKyc++;
      console.log(` KYC record ${kyc._id} migrated`);
    }
  }

  console.log("\n=================================");
  console.log("🎉 Migration Complete!");
  console.log(`- Categories migrated: ${migratedCategories}`);
  console.log(`- Services migrated: ${migratedServices}`);
  console.log(`- Products migrated: ${migratedProducts}`);
  console.log(`- Technician Profiles migrated: ${migratedTechProfiles}`);
  console.log(`- KYC Records migrated: ${migratedKyc}`);
  console.log("=================================\n");

  await mongoose.disconnect();
}

runMigration().catch((err) => {
  console.error("Migration fatal error:", err);
  process.exit(1);
});
