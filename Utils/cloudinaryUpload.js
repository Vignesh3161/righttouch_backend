import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

dotenv.config();

/* ======================================================
   CLOUDINARY CONFIGURATION
====================================================== */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET,
}); 


/* ======================================================
   CLOUDINARY STORAGE CONFIG
====================================================== */
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const fileName = file.originalname
      .split(".")[0]
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "")
      .toLowerCase();

    return {
      folder: "boutique/category",
      allowed_formats: ["jpg", "jpeg", "png", "webp", "jfif"],
      public_id: `${Date.now()}-${fileName}`,
      transformation: [
        {
          quality: "auto",
          fetch_format: "auto",
        },
      ],
    };
  },
});

/* ======================================================
   KYC STORAGE (PRIVATE — identity documents)
   Uploaded with access_mode "authenticated"; must be
   served via signed URLs generated at read time.
====================================================== */
const kycStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "kyc/documents",
    access_mode: "authenticated",
    resource_type: "image",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
  },
});

/* ======================================================
   FILE FILTER (IMAGES ONLY)
====================================================== */
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/jpg",
    "image/webp",
  ];

  const ext = file.originalname.split(".").pop().toLowerCase();

  if (!allowedMimeTypes.includes(file.mimetype) && ext !== "jfif") {
    const error = new Error("Only JPG, JPEG, PNG, WEBP, JFIF images are allowed");
    error.status = 400; // Return 400 Bad Request
    return cb(error, false);
  }

  cb(null, true);
};

/* ======================================================
   MULTER UPLOAD CONFIG (20MB LIMIT)
====================================================== */
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

/* ======================================================
   MULTER UPLOAD CONFIG FOR KYC DOCS (private storage)
====================================================== */
export const kycUpload = multer({
  storage: kycStorage,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

/**
 * Generate a short-lived signed URL for an authenticated (private)
 * Cloudinary resource. Accepts either a public_id (new uploads) or a
 * legacy full URL (old public uploads) — legacy URLs are returned as-is.
 *
 * @param {String} publicIdOrUrl Cloudinary public_id or full URL
 * @param {Number} ttlSeconds Default 300 (5 min)
 * @returns {String} Signed URL
 */
export const getSignedKycUrl = (publicIdOrUrl, ttlSeconds = 300) => {
  if (!publicIdOrUrl) return publicIdOrUrl;
  if (/^https?:\/\//.test(publicIdOrUrl)) return publicIdOrUrl; // legacy public URL
  return cloudinary.url(publicIdOrUrl, {
    sign_url: true,
    type: "authenticated",
    expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    fetch_format: "auto",
  });
};

export { cloudinary };
