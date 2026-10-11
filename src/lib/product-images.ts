import { randomUUID } from "node:crypto";
import type { Request, RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { ApiError } from "./errors.js";

/** Product photos are public catalogue assets, kept separate from compliance documents. */
export const PRODUCT_IMAGE_MAX_MB = 5;
export const PRODUCT_IMAGE_PREFIX = "products/";

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
type ImageMime = keyof typeof EXTENSIONS;
export const CONTENT_TYPES: Record<string, ImageMime> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Only names this module generates are ever served: a UUID plus a known extension. */
export const PRODUCT_IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PRODUCT_IMAGE_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) =>
    file.mimetype in EXTENSIONS
      ? callback(null, true)
      : callback(new ApiError(415, `${file.originalname} must be a JPG, PNG or WebP image`, "UNSUPPORTED_FILE_TYPE")),
});

/** Single-file "image" upload, with a size message that states the image limit. */
export const productImageUpload: RequestHandler = (request, response, next) =>
  upload.single("image")(request, response, (error: unknown) => {
    if (error instanceof MulterError && error.code === "LIMIT_FILE_SIZE") {
      return next(new ApiError(413, `Product images must be ${PRODUCT_IMAGE_MAX_MB} MB or smaller`, "IMAGE_TOO_LARGE"));
    }
    next(error);
  });

/**
 * The declared MIME type comes from the browser and can be spoofed, so the
 * file's leading bytes must also match before it is stored and served.
 */
export function detectImageType(buffer: Buffer): ImageMime | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function productImageName(mime: ImageMime) {
  return `${randomUUID()}.${EXTENSIONS[mime]}`;
}

/** Absolute URL for a stored image, built from the request so it works behind the Railway proxy. */
export function productImageUrl(request: Request, name: string) {
  return `${request.protocol}://${request.get("host")}/api/v1/catalog/images/${name}`;
}
