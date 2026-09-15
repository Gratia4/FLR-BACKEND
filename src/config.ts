import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("2h"),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  UPLOAD_DIR: z.string().default("uploads"),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(25).default(10),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  console.error("Invalid environment configuration", result.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...result.data,
  corsOrigins: result.data.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
};
