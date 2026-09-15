import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { ApiError } from "../lib/errors.js";

export const notFound: RequestHandler = (_request, _response, next) => next(new ApiError(404, "Route not found", "NOT_FOUND"));

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "Invalid request data", details: error.flatten() } });
    return;
  }
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  if (isDatabaseError(error)) {
    const duplicate = error.code === "23505";
    response.status(duplicate ? 409 : 400).json({ error: { code: duplicate ? "CONFLICT" : "DATABASE_ERROR", message: duplicate ? "A record with that value already exists" : "Database request failed" } });
    return;
  }
  request.log?.error?.({ err: error }, "Unhandled request error");
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
};

function isDatabaseError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
