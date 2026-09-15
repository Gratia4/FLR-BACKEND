import type { RequestHandler } from "express";
import { ApiError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/auth.js";
import type { UserRole } from "../types.js";

export const authenticate: RequestHandler = (request, _response, next) => {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return next(new ApiError(401, "Authentication required", "UNAUTHENTICATED"));
  try {
    const token = verifyAccessToken(value.slice(7));
    request.auth = { userId: token.sub, businessId: token.businessId, role: token.role };
    next();
  } catch {
    next(new ApiError(401, "Invalid or expired access token", "INVALID_TOKEN"));
  }
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (request, _response, next) => request.auth && roles.includes(request.auth.role)
    ? next()
    : next(new ApiError(403, "Insufficient permissions", "FORBIDDEN"));
}
