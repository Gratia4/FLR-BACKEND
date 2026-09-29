import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),

  // ---- auth ----
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("2h"),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().max(90).default(14),
  PASSWORD_RESET_MINUTES: z.coerce.number().int().positive().max(1440).default(60),
  MAX_FAILED_LOGINS: z.coerce.number().int().positive().max(20).default(6),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().max(1440).default(15),

  // ---- network ----
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  PUBLIC_APP_URL: z.string().default("http://localhost:3000"),

  // ---- documents ----
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  UPLOAD_DIR: z.string().default("uploads"),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(25).default(10),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  DOCUMENT_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),

  // ---- email ----
  MAIL_DRIVER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("FLR Ltd. <no-reply@flr.rw>"),
  OPS_NOTIFICATION_EMAIL: z.string().optional(),

  // ---- commerce ----
  DEFAULT_VAT_RATE: z.coerce.number().min(0).max(1).default(0.18),
  DEFAULT_PAYMENT_TERMS_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  EXPIRY_ALERT_DAYS: z.coerce.number().int().positive().default(90),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  console.error("Invalid environment configuration", z.flattenError(result.error).fieldErrors);
  process.exit(1);
}

const data = result.data;

if (data.STORAGE_DRIVER === "s3" && !(data.S3_BUCKET && data.S3_ACCESS_KEY_ID && data.S3_SECRET_ACCESS_KEY)) {
  console.error("STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
  process.exit(1);
}
if (data.MAIL_DRIVER === "resend" && !data.RESEND_API_KEY) {
  console.error("MAIL_DRIVER=resend requires RESEND_API_KEY");
  process.exit(1);
}
if (data.NODE_ENV === "production" && data.STORAGE_DRIVER === "local") {
  console.warn(
    "[config] STORAGE_DRIVER=local in production. Container filesystems are ephemeral — " +
      "uploaded compliance documents will be lost on the next deploy. Configure S3/R2.",
  );
}

export const config = {
  ...data,
  corsOrigins: data.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
  publicAppUrl: data.PUBLIC_APP_URL.replace(/\/$/, ""),
};
