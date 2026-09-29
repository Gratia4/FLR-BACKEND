import type { ErrorRequestHandler, RequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError, z } from "zod";
import { ApiError } from "../lib/errors.js";
import { config } from "../config.js";

export const notFound: RequestHandler = (_request, _response, next) => next(new ApiError(404, "Route not found", "NOT_FOUND"));

/** Postgres error codes worth translating into something a user can act on. */
const DATABASE_MESSAGES: Record<string, { status: number; code: string; message: string }> = {
  "23505": { status: 409, code: "CONFLICT", message: "A record with that value already exists" },
  "23503": { status: 422, code: "REFERENCE_NOT_FOUND", message: "A referenced record does not exist" },
  "23514": { status: 422, code: "CONSTRAINT_VIOLATION", message: "That value is outside the allowed range" },
  "22P02": { status: 400, code: "INVALID_INPUT", message: "One of the supplied values has the wrong format" },
};

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (error instanceof ZodError) {
    const flattened = z.flattenError(error);
    response.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        // Surface the first field message so the UI has something specific to show.
        message: Object.values(flattened.fieldErrors).flat()[0] ?? "Please check the highlighted fields",
        details: flattened,
      },
    });
    return;
  }

  if (error instanceof MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? `Each file must be ${config.MAX_UPLOAD_MB} MB or smaller`
        : error.code === "LIMIT_UNEXPECTED_FILE"
          ? "An unexpected file was uploaded"
          : "That upload could not be processed";
    response.status(413).json({ error: { code: error.code, message } });
    return;
  }

  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }

  const databaseCode = typeof error === "object" && error !== null && "code" in error ? String((error as { code: string }).code) : null;
  const mapped = databaseCode ? DATABASE_MESSAGES[databaseCode] : undefined;
  if (mapped) {
    request.log?.warn?.({ err: error }, "Database constraint rejected the request");
    response.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }

  request.log?.error?.({ err: error }, "Unhandled request error");
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
};
