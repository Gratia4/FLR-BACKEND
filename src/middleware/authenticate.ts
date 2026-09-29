import type { RequestHandler } from "express";
import { ApiError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/auth.js";
import { query } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { PERMISSIONS, type PermissionArea, type UserRole } from "../types.js";

export const authenticate: RequestHandler = (request, _response, next) => {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return next(new ApiError(401, "Authentication required", "UNAUTHENTICATED"));
  try {
    const token = verifyAccessToken(value.slice(7));
    request.auth = { userId: token.sub, businessId: token.businessId, role: token.role, status: token.status ?? null };
    next();
  } catch {
    next(new ApiError(401, "Your session has expired. Please sign in again.", "INVALID_TOKEN"));
  }
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (request, _response, next) =>
    request.auth && roles.includes(request.auth.role)
      ? next()
      : next(new ApiError(403, "Insufficient permissions", "FORBIDDEN"));
}

/** Role gate expressed as a console area rather than a hand-maintained role list. */
export function requirePermission(area: PermissionArea): RequestHandler {
  const roles = PERMISSIONS[area] as readonly UserRole[];
  return (request, _response, next) =>
    request.auth && roles.includes(request.auth.role)
      ? next()
      : next(new ApiError(403, `Your role does not have access to ${area}`, "FORBIDDEN", { area }));
}

/** Any member of staff — used for read-only console endpoints. */
export const requireStaff: RequestHandler = (request, _response, next) =>
  request.auth && request.auth.role !== "CLIENT"
    ? next()
    : next(new ApiError(403, "Staff access required", "FORBIDDEN"));

/**
 * Re-checks the business status against the database on every privileged client
 * request. The JWT is valid for hours, so a suspension applied mid-session must
 * not leave wholesale pricing and ordering open until the token expires.
 */
export const requireApprovedClient: RequestHandler = asyncHandler(async (request, _response, next) => {
  const auth = request.auth;
  if (!auth) throw new ApiError(401, "Authentication required", "UNAUTHENTICATED");
  if (!auth.businessId) throw new ApiError(403, "A client business account is required", "CLIENT_ONLY");

  const result = await query<{ status: string; is_active: boolean }>(
    `SELECT b.status, u.is_active FROM businesses b JOIN users u ON u.id = $2 WHERE b.id = $1`,
    [auth.businessId, auth.userId],
  );
  const row = result.rows[0];
  if (!row || !row.is_active) throw new ApiError(403, "This account is no longer active", "ACCOUNT_INACTIVE");
  if (row.status !== "APPROVED") {
    throw new ApiError(403, "This account is not approved for wholesale ordering", `ACCOUNT_${row.status}`);
  }
  request.auth = { ...auth, status: row.status as "APPROVED" };
  next();
});
