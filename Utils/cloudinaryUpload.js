 import multer from "multer";
import { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import dotenv from "dotenv";

dotenv.config();

/* ======================================================
   GOOGLE CLOUD STORAGE CONFIG
====================================================== */

const storage = new Storage();

const bucket = storage.bucket(
  process.env.GOOGLE_CLOUD_BUCKET_NAME
);

/* ======================================================
   MULTER MEMORY STORAGE
====================================================== */

const multerStorage = multer.memoryStorage();

/* ======================================================
   FILE FILTER (IMAGES ONLY)
====================================================== */

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/jpg",
    "image/webp",
    "image/jfif",
  ];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(
      new Error(
        "Only JPG, JPEG, PNG, WEBP, JFIF images are allowed"
      ),
      false
    );
  }

  cb(null, true);
};

/* ======================================================
   MULTER CONFIG
====================================================== */

export const upload = multer({
  storage: multerStorage,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

/* ======================================================
   GOOGLE CLOUD IMAGE UPLOAD
====================================================== */

export const uploadToGCS = async (
  file,
  folder = "uploads"
) => {
  try {
    const fileName = `${Date.now()}.webp`;

    const blob = bucket.file(
      `${folder}/${fileName}`
    );

    /* ==========================================
       IMAGE OPTIMIZATION
    ========================================== */

    const optimizedBuffer = await sharp(file.buffer)
      .resize({
        width: 1200,
        withoutEnlargement: true,
      })
      .webp({
        quality: 80,
      })
      .toBuffer();

    const blobStream = blob.createWriteStream({
      resumable: false,
      metadata: {
        contentType: "image/webp",
      },
    });

    return new Promise((resolve, reject) => {
      blobStream.on("error", reject);

blobStream.on("finish", async () => {
  const publicUrl = `https://storage.googleapis.com/${process.env.GOOGLE_CLOUD_BUCKET_NAME}/${blob.name}`;

  console.log("Generated URL:", publicUrl);

  file.path = publicUrl;

  resolve(publicUrl);
});

      blobStream.end(optimizedBuffer);
    });
    console.log("Uploading file...");
  } catch (error) {
    throw error;
  }
};