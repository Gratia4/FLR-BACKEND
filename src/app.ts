import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { query } from "./db.js";
import authRoutes from "./routes/auth.js";
import registrationRoutes from "./routes/registrations.js";
import catalogRoutes from "./routes/catalog.js";
import orderRoutes from "./routes/orders.js";
import cartRoutes from "./routes/cart.js";
import accountRoutes from "./routes/account.js";
import documentRoutes from "./routes/documents.js";
import adminRoutes from "./routes/admin/index.js";
import { asyncHandler } from "./lib/async-handler.js";
import { ApiError } from "./lib/errors.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";

export const app = express();

function isLocalDevelopmentOrigin(origin: string) {
  if (config.NODE_ENV !== "development") return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || !["3000", "3001"].includes(url.port)) return false;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return true;
    if (/^10\./.test(url.hostname) || /^192\.168\./.test(url.hostname)) return true;
    const match = url.hostname.match(/^172\.(\d{1,2})\./);
    return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
  } catch {
    return false;
  }
}

app.set("trust proxy", config.TRUST_PROXY);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.confirmPassword",
      "req.body.currentPassword",
      "req.body.refreshToken",
      "req.body.token",
      "req.query.token",
    ],
  }),
);

app.use(
  helmet({
    // Documents are streamed to a different origin (the Firebase-hosted console).
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin) || isLocalDevelopmentOrigin(origin)) return callback(null, true);
      callback(new ApiError(403, "Origin not allowed", "CORS_DENIED"));
    },
    credentials: true,
    exposedHeaders: ["Content-Disposition"],
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false }));

/* --------------------------------- health --------------------------------- */

app.get("/health", (_request, response) =>
  response.json({ status: "ok", service: "flr-backend", timestamp: new Date().toISOString() }),
);

app.get(
  "/ready",
  asyncHandler(async (_request, response) => {
    await query("SELECT 1");
    response.json({
      status: "ready",
      database: "connected",
      storage: config.STORAGE_DRIVER,
      mail: config.MAIL_DRIVER,
    });
  }),
);

/* --------------------------------- routes --------------------------------- */

// Credential endpoints are rate limited far harder than the rest of the API.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false });
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });

app.use("/api/v1/auth/forgot-password", resetLimiter);
app.use("/api/v1/auth/reset-password", resetLimiter);
app.use("/api/v1/auth", authLimiter, authRoutes);
app.use("/api/v1/registrations", registrationLimiter, registrationRoutes);
app.use("/api/v1/catalog", catalogRoutes);
app.use("/api/v1/cart", cartRoutes);
app.use("/api/v1/orders", orderRoutes);
app.use("/api/v1/account", accountRoutes);
app.use("/api/v1/documents", documentRoutes);
app.use("/api/v1/admin", adminRoutes);

app.use(notFound);
app.use(errorHandler);
