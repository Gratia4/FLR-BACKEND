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
import adminRoutes from "./routes/admin.js";
import { asyncHandler } from "./lib/async-handler.js";
import { ApiError } from "./lib/errors.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";

export const app = express();
app.set("trust proxy", config.TRUST_PROXY);
app.disable("x-powered-by");
app.use(pinoHttp({ redact: ["req.headers.authorization", "req.body.password", "req.body.confirmPassword"] }));
app.use(helmet());
app.use(cors({ origin(origin, callback) {
  if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
  callback(new ApiError(403, "Origin not allowed", "CORS_DENIED"));
}, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));

app.get("/health", (_request, response) => response.json({ status: "ok", service: "flr-backend", timestamp: new Date().toISOString() }));
app.get("/ready", asyncHandler(async (_request, response) => { await query("SELECT 1"); response.json({ status: "ready", database: "connected" }); }));
app.use("/api/v1/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }), authRoutes);
app.use("/api/v1/registrations", rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 }), registrationRoutes);
app.use("/api/v1/catalog", catalogRoutes);
app.use("/api/v1/orders", orderRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use(notFound);
app.use(errorHandler);
