import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { createAccessToken } from "../lib/auth.js";
import { query } from "../db.js";

const router = Router();
const loginSchema = z.object({ email: z.email(), password: z.string().min(8).max(128) });

router.post("/login", asyncHandler(async (request, response) => {
  const input = loginSchema.parse(request.body);
  const result = await query<{
    id: string; business_id: string | null; email: string; password_hash: string; full_name: string;
    role: "CLIENT" | "SUPER_ADMIN" | "SALES_MANAGER" | "CONTENT_MANAGER" | "LOGISTICS" | "FINANCE";
    is_active: boolean; status: "PENDING" | "APPROVED" | "SUSPENDED" | "REJECTED" | null; business_name: string | null;
  }>(`SELECT u.id, u.business_id, u.email, u.password_hash, u.full_name, u.role, u.is_active,
      b.status, b.name AS business_name
    FROM users u LEFT JOIN businesses b ON b.id = u.business_id
    WHERE lower(u.email) = lower($1)`, [input.email]);
  const user = result.rows[0];
  if (!user || !user.is_active || !(await bcrypt.compare(input.password, user.password_hash))) {
    throw new ApiError(401, "Incorrect email or password", "INVALID_CREDENTIALS");
  }
  if (user.role === "CLIENT" && user.status !== "APPROVED") {
    const messages = {
      PENDING: "Your account is pending verification. You will be notified within 24–48 business hours.",
      SUSPENDED: "Your account has been temporarily restricted. Please contact FLR Ltd. support.",
      REJECTED: "Your registration could not be approved. Please contact FLR Ltd. support.",
    } as const;
    throw new ApiError(403, messages[user.status as keyof typeof messages] ?? "Account unavailable", `ACCOUNT_${user.status ?? "UNAVAILABLE"}`);
  }
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  response.json({
    accessToken: createAccessToken({ sub: user.id, businessId: user.business_id, role: user.role }),
    expiresIn: "2h",
    user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, businessId: user.business_id, businessName: user.business_name },
  });
}));

export default router;
