import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { ApiError } from "./errors.js";

export type StorageProvider = "LOCAL" | "S3";

export type StoredObject = {
  key: string;
  provider: StorageProvider;
  sizeBytes: number;
  checksum: string;
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

export function buildDocumentKey(businessId: string, documentType: string, mimeType: string) {
  const extension = EXTENSION_BY_MIME[mimeType] ?? "";
  return `registrations/${businessId}/${documentType.toLowerCase()}-${randomUUID()}${extension}`;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export async function putObject(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
  const checksum = createHash("sha256").update(body).digest("hex");
  if (config.STORAGE_DRIVER === "s3") {
    await s3Put(key, body, contentType, checksum);
    return { key, provider: "S3", sizeBytes: body.byteLength, checksum };
  }
  const destination = localPath(key);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, body);
  return { key, provider: "LOCAL", sizeBytes: body.byteLength, checksum };
}

/**
 * Returns a URL the browser can fetch directly, or null when the object must be
 * streamed back through the API (local driver).
 */
export function presignedUrl(key: string, provider: StorageProvider): string | null {
  if (provider !== "S3") return null;
  return s3PresignGet(key, config.DOCUMENT_URL_TTL_SECONDS);
}

export function localReadStream(key: string) {
  return createReadStream(localPath(key));
}

export async function objectExists(key: string, provider: StorageProvider) {
  if (provider === "S3") return true; // trust the record; S3 HEAD costs a round trip per row
  try {
    await stat(localPath(key));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string, provider: StorageProvider) {
  if (provider === "S3") return s3Delete(key);
  await unlink(localPath(key)).catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Local driver
 * ------------------------------------------------------------------ */

function localPath(key: string) {
  const root = path.resolve(config.UPLOAD_DIR);
  const resolved = path.resolve(root, key);
  // Defence in depth: a crafted storage_key must never escape the upload root.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ApiError(400, "Invalid storage key", "INVALID_STORAGE_KEY");
  }
  return resolved;
}

/* ------------------------------------------------------------------ *
 * S3 / R2 driver — AWS SigV4, no SDK dependency
 * ------------------------------------------------------------------ */

const SERVICE = "s3";
const UNSIGNED = "UNSIGNED-PAYLOAD";

function s3Host() {
  if (config.S3_ENDPOINT) return new URL(config.S3_ENDPOINT).host;
  return `s3.${config.S3_REGION}.amazonaws.com`;
}

function s3Origin() {
  if (config.S3_ENDPOINT) return config.S3_ENDPOINT.replace(/\/$/, "");
  return `https://s3.${config.S3_REGION}.amazonaws.com`;
}

function objectPath(key: string) {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `/${config.S3_BUCKET}/${encoded}`;
}

function stamps(now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(dateStamp: string) {
  const kDate = createHmac("sha256", `AWS4${config.S3_SECRET_ACCESS_KEY}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(config.S3_REGION).digest();
  const kService = createHmac("sha256", kRegion).update(SERVICE).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

function sign(stringToSign: string, dateStamp: string) {
  return createHmac("sha256", signingKey(dateStamp)).update(stringToSign).digest("hex");
}

function credentialScope(dateStamp: string) {
  return `${dateStamp}/${config.S3_REGION}/${SERVICE}/aws4_request`;
}

/** Presigned GET — the browser downloads straight from the bucket. */
function s3PresignGet(key: string, ttlSeconds: number) {
  const { amzDate, dateStamp } = stamps();
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.S3_ACCESS_KEY_ID}/${credentialScope(dateStamp)}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttlSeconds),
    "X-Amz-SignedHeaders": "host",
  });
  query.sort();
  const canonicalRequest = [
    "GET",
    objectPath(key),
    query.toString(),
    `host:${s3Host()}\n`,
    "host",
    UNSIGNED,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope(dateStamp),
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  query.append("X-Amz-Signature", sign(stringToSign, dateStamp));
  return `${s3Origin()}${objectPath(key)}?${query.toString()}`;
}

async function s3Request(method: "PUT" | "DELETE", key: string, body: Buffer, contentType?: string) {
  const { amzDate, dateStamp } = stamps();
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const headers: Record<string, string> = {
    host: s3Host(),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [method, objectPath(key), "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope(dateStamp),
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.S3_ACCESS_KEY_ID}/${credentialScope(dateStamp)}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sign(stringToSign, dateStamp)}`;

  const response = await fetch(`${s3Origin()}${objectPath(key)}`, {
    method,
    headers: { ...headers, authorization },
    body: method === "PUT" ? new Uint8Array(body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ApiError(502, "Document storage is unavailable", "STORAGE_ERROR", detail.slice(0, 300));
  }
}

function s3Put(key: string, body: Buffer, contentType: string, _checksum: string) {
  return s3Request("PUT", key, body, contentType);
}

function s3Delete(key: string) {
  return s3Request("DELETE", key, Buffer.alloc(0));
}
