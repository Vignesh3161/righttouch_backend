import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

dotenv.config();

// --------------------------------------------------
// ✅ Cloudinary Configuration
// --------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --------------------------------------------------
// ✅ Cloudinary Storage Configuration
// --------------------------------------------------
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "boutique/category", // change folder as needed
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    public_id: `${Date.now()}-${file.originalname.split(".")[0]}`,
    transformation: [
      {
        quality: "auto",
        fetch_format: "auto",
      },
    ],
  }),
});

// --------------------------------------------------
// ✅ File Filter (Images only)
// --------------------------------------------------
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/jpg",
    "image/webp",
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error("Only JPG, JPEG, PNG, WEBP images are allowed"),
      false
    );
  }
};

// --------------------------------------------------
// ✅ Multer Upload (20MB limit)
// --------------------------------------------------
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

export { cloudinary };
