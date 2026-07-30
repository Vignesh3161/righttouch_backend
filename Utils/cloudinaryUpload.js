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

export { cloudinary };
