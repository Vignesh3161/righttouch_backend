import https from "https";
import crypto from "crypto";
import multer from "multer";
import dotenv from "dotenv";

dotenv.config();

const getStorageHost = () => process.env.BUNNY_STORAGE_HOSTNAME || "storage.bunnycdn.com";
const getStorageZone = () => process.env.BUNNY_STORAGE_ZONE_NAME || "";
const getStorageApiKey = () => process.env.BUNNY_STORAGE_API_KEY || "";
const getCdnHostname = () => (process.env.BUNNY_CDN_HOSTNAME || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const getTokenSecurityKey = () => process.env.BUNNY_TOKEN_SECURITY_KEY || "";

/**
 * Custom Multer storage engine that streams files directly to Bunny.net Storage.
 */
class BunnyStorageEngine {
  constructor(options = {}) {
    this.folder = (options.folder || "uploads").replace(/^\/+|\/+$/g, "");
    this.allowedFormats = options.allowedFormats || ["jpg", "jpeg", "png", "webp", "jfif"];
  }

  _handleFile(req, file, cb) {
    const storageHost = getStorageHost();
    const storageZone = getStorageZone();
    const apiKey = getStorageApiKey();
    const cdnHost = getCdnHostname();

    if (!storageZone || !apiKey) {
      return cb(new Error("Bunny Storage is not configured. Missing BUNNY_STORAGE_ZONE_NAME or BUNNY_STORAGE_API_KEY."));
    }

    const extMatch = file.originalname.match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";

    const baseName = file.originalname
      .replace(/\.[^/.]+$/, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "")
      .toLowerCase()
      .slice(0, 80);

    const fileName = `${Date.now()}-${baseName || "file"}.${ext}`;
    const relativePath = `${this.folder}/${fileName}`;
    const cleanPath = relativePath.replace(/^\/+/, "");

    const url = `https://${storageHost}/${storageZone}/${cleanPath}`;

    let bytesWritten = 0;
    const uploadReq = https.request(
      url,
      {
        method: "PUT",
        headers: {
          AccessKey: apiKey,
          "Content-Type": file.mimetype || "application/octet-stream",
        },
      },
      (res) => {
        let responseData = "";
        res.on("data", (chunk) => (responseData += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const publicUrl = cdnHost ? `https://${cdnHost}/${cleanPath}` : url;
            cb(null, {
              path: publicUrl,
              filename: cleanPath,
              public_id: cleanPath,
              size: bytesWritten,
              mimetype: file.mimetype,
            });
          } else {
            cb(new Error(`Bunny storage upload failed with status ${res.statusCode}: ${responseData}`));
          }
        });
      }
    );

    uploadReq.on("error", (err) => cb(err));

    file.stream.on("data", (chunk) => {
      bytesWritten += chunk.length;
    });

    file.stream.pipe(uploadReq);
  }

  _removeFile(req, file, cb) {
    if (file && file.filename) {
      deleteFromBunny(file.filename).catch(() => {});
    }
    cb(null);
  }
}

/**
 * File filter helper for image formats
 */
const imageFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/jpg",
    "image/webp",
  ];
  const ext = file.originalname.split(".").pop().toLowerCase();

  if (!allowedMimeTypes.includes(file.mimetype) && ext !== "jfif") {
    const error = new Error("Only JPG, JPEG, PNG, WEBP, JFIF images are allowed");
    error.status = 400;
    return cb(error, false);
  }

  cb(null, true);
};

/* ======================================================
   PUBLIC MULTER UPLOAD (Categories, Services, Products, Avatars)
====================================================== */
export const upload = multer({
  storage: new BunnyStorageEngine({
    folder: "boutique/category",
    allowedFormats: ["jpg", "jpeg", "png", "webp", "jfif"],
  }),
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

/* ======================================================
   PRIVATE KYC MULTER UPLOAD (Aadhaar, PAN, DL)
====================================================== */
export const kycUpload = multer({
  storage: new BunnyStorageEngine({
    folder: "kyc/documents",
    allowedFormats: ["jpg", "jpeg", "png", "webp"],
  }),
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

/**
 * Generate a signed URL for private resources (KYC documents) using Bunny URL Token Authentication.
 * Backward compatible: if passed an existing Cloudinary URL, passes through safely.
 *
 * @param {String} publicIdOrUrl Storage path or full URL
 * @param {Number} ttlSeconds Default 300 (5 minutes)
 * @returns {String} Signed URL (or public URL if token key is not configured)
 */
export const getSignedKycUrl = (publicIdOrUrl, ttlSeconds = 300) => {
  if (!publicIdOrUrl) return publicIdOrUrl;

  // Backward compatibility: If it is a legacy Cloudinary URL, keep as-is
  if (publicIdOrUrl.includes("res.cloudinary.com")) {
    return publicIdOrUrl;
  }

  const cdnHost = getCdnHostname();
  const securityKey = getTokenSecurityKey();

  // Extract the relative path
  let relativePath = publicIdOrUrl;
  if (/^https?:\/\//.test(publicIdOrUrl)) {
    try {
      const parsed = new URL(publicIdOrUrl);
      relativePath = parsed.pathname;
    } catch {
      relativePath = publicIdOrUrl.replace(/^https?:\/\/[^/]+/, "");
    }
  }

  if (!relativePath.startsWith("/")) {
    relativePath = `/${relativePath}`;
  }

  const baseUrl = cdnHost ? `https://${cdnHost}${relativePath}` : relativePath;

  // If token security key is configured, generate Bunny URL Token (SHA-256 HMAC / Hash)
  if (securityKey) {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const hashable = `${securityKey}${relativePath}${expires}`;
    const token = crypto.createHash("sha256").update(hashable).digest("base64url");
    return `${baseUrl}?token=${token}&expires=${expires}`;
  }

  // Without token security key, return direct CDN URL
  return baseUrl;
};

/**
 * Helper to delete a file from Bunny Storage
 *
 * @param {String} filePath Relative file path inside the storage zone
 */
export const deleteFromBunny = (filePath) => {
  return new Promise((resolve, reject) => {
    const storageHost = getStorageHost();
    const storageZone = getStorageZone();
    const apiKey = getStorageApiKey();

    if (!storageZone || !apiKey || !filePath) {
      return resolve(false);
    }

    const cleanPath = filePath.replace(/^\/+/, "");
    const url = `https://${storageHost}/${storageZone}/${cleanPath}`;

    const req = https.request(
      url,
      {
        method: "DELETE",
        headers: {
          AccessKey: apiKey,
        },
      },
      (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          resolve(false);
        }
      }
    );

    req.on("error", () => resolve(false));
    req.end();
  });
};
