import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import {
  createAccessToken,
  hashToken,
  issueOpaqueToken,
  persistRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshToken,
} from "../lib/auth.js";
import { mails } from "../lib/mailer.js";
import { query, transaction } from "../db.js";
import { authenticate } from "../middleware/authenticate.js";
import type { AccountStatus, UserRole } from "../types.js";

const router = Router();

const passwordRules = z
  .string()
  .min(8)
  .max(128)
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[0-9]/, "Include a number")
  .regex(/[^A-Za-z0-9]/, "Include a symbol");

type UserRow = {
  id: string;
  business_id: string | null;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
  preferred_language: string;
  status: AccountStatus | null;
  business_name: string | null;
};

const STATUS_MESSAGES: Record<string, string> = {
  PENDING: "Your account is pending verification. You will be notified within 24–48 business hours.",
  SUSPENDED: "Your account has been temporarily restricted. Please contact FLR Ltd. support.",
  REJECTED: "Your registration could not be approved. Please contact FLR Ltd. support.",
};

function sessionPayload(user: UserRow, accessToken: string, refreshToken: string) {
  return {
    accessToken,
    refreshToken,
    expiresIn: config.JWT_EXPIRES_IN,
    mustChangePassword: user.must_change_password,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      businessId: user.business_id,
      businessName: user.business_name,
      preferredLanguage: user.preferred_language,
    },
  };
}

/* ---------------------------------- login --------------------------------- */

router.post(
  "/login",
  asyncHandler(async (request, response) => {
    const input = z.object({ email: z.email(), password: z.string().min(1).max(128) }).parse(request.body);

    const result = await query<UserRow>(
      `SELECT u.id,u.business_id,u.email,u.password_hash,u.full_name,u.role,u.is_active,
              u.must_change_password,u.failed_login_attempts,u.locked_until,u.preferred_language,
              b.status, b.name AS business_name
         FROM users u LEFT JOIN businesses b ON b.id = u.business_id
        WHERE lower(u.email) = lower($1)`,
      [input.email],
    );
    const user = result.rows[0];

    if (user?.locked_until && user.locked_until > new Date()) {
      throw new ApiError(
        429,
        `Too many failed attempts. Try again after ${user.locked_until.toISOString().slice(11, 16)} UTC.`,
        "ACCOUNT_LOCKED",
      );
    }

    // Always run a comparison so response timing does not reveal whether the
    // address exists. The dummy hash below is a bcrypt digest of a random value.
    const passwordMatches = await bcrypt.compare(
      input.password,
      user?.password_hash ?? "$2a$12$c2hvdWxkbmV2ZXJtYXRjaOwCMH0X0KpZJL9a9R2XfKQ3.dV5wGJZq",
    );

    if (!user || !user.is_active || !passwordMatches) {
      if (user) await registerFailedAttempt(user);
      throw new ApiError(401, "Incorrect email or password", "INVALID_CREDENTIALS");
    }

    if (user.role === "CLIENT" && user.status !== "APPROVED") {
      throw new ApiError(
        403,
        STATUS_MESSAGES[user.status ?? ""] ?? "Account unavailable",
        `ACCOUNT_${user.status ?? "UNAVAILABLE"}`,
      );
    }

    await query(
      `UPDATE users SET last_login_at = now(), failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [user.id],
    );

    const accessToken = createAccessToken({
      sub: user.id,
      businessId: user.business_id,
      role: user.role,
      status: user.status,
    });
    const refresh = issueOpaqueToken();
    await persistRefreshToken(user.id, refresh.hash, {
      userAgent: request.headers["user-agent"],
      ip: request.ip,
    });

    response.json(sessionPayload(user, accessToken, refresh.token));
  }),
);

async function registerFailedAttempt(user: UserRow) {
  await query(
    `UPDATE users
        SET locked_until = CASE
              WHEN failed_login_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
              ELSE locked_until END,
            failed_login_attempts = CASE
              WHEN failed_login_attempts + 1 >= $2 THEN 0
              ELSE failed_login_attempts + 1 END
      WHERE id = $1`,
    [user.id, config.MAX_FAILED_LOGINS, String(config.LOCKOUT_MINUTES)],
  );
}

/* --------------------------------- refresh -------------------------------- */

router.post(
  "/refresh",
  asyncHandler(async (request, response) => {
    const input = z.object({ refreshToken: z.string().min(20).max(200) }).parse(request.body);
    const hash = hashToken(input.refreshToken);

    const result = await query<UserRow & { token_id: string }>(
      `SELECT r.id AS token_id, u.id,u.business_id,u.email,u.password_hash,u.full_name,u.role,u.is_active,
              u.must_change_password,u.failed_login_attempts,u.locked_until,u.preferred_language,
              b.status, b.name AS business_name
         FROM refresh_tokens r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN businesses b ON b.id = u.business_id
        WHERE r.token_hash = $1 AND r.revoked_at IS NULL AND r.expires_at > now()`,
      [hash],
    );
    const user = result.rows[0];
    if (!user || !user.is_active) throw new ApiError(401, "Your session has expired. Please sign in again.", "INVALID_REFRESH_TOKEN");
    if (user.role === "CLIENT" && user.status !== "APPROVED") {
      await revokeRefreshToken(hash);
      throw new ApiError(403, STATUS_MESSAGES[user.status ?? ""] ?? "Account unavailable", `ACCOUNT_${user.status ?? "UNAVAILABLE"}`);
    }

    // Rotate: the presented token is retired and replaced on every refresh.
    await revokeRefreshToken(hash);
    const refresh = issueOpaqueToken();
    await persistRefreshToken(user.id, refresh.hash, { userAgent: request.headers["user-agent"], ip: request.ip });

    const accessToken = createAccessToken({
      sub: user.id,
      businessId: user.business_id,
      role: user.role,
      status: user.status,
    });
    response.json(sessionPayload(user, accessToken, refresh.token));
  }),
);

router.post(
  "/logout",
  asyncHandler(async (request, response) => {
    const input = z.object({ refreshToken: z.string().min(20).max(200).optional() }).parse(request.body ?? {});
    if (input.refreshToken) await revokeRefreshToken(hashToken(input.refreshToken));
    response.json({ ok: true });
  }),
);

/* ----------------------------- password reset ----------------------------- */

router.post(
  "/forgot-password",
  asyncHandler(async (request, response) => {
    const input = z.object({ email: z.email() }).parse(request.body);
    const result = await query<{ id: string; full_name: string; email: string; is_active: boolean }>(
      `SELECT id, full_name, email, is_active FROM users WHERE lower(email) = lower($1)`,
      [input.email],
    );
    const user = result.rows[0];

    if (user?.is_active) {
      // One live reset link at a time.
      await query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
      const reset = issueOpaqueToken();
      await query(
        `INSERT INTO password_reset_tokens(user_id,token_hash,expires_at)
         VALUES($1,$2, now() + ($3 || ' minutes')::interval)`,
        [user.id, reset.hash, String(config.PASSWORD_RESET_MINUTES)],
      );
      await mails.passwordReset(user.email, user.full_name, reset.token, config.PASSWORD_RESET_MINUTES);
    }

    // Identical response either way: the endpoint must not confirm who has an account.
    response.json({ message: "If that email is registered, a reset link is on its way." });
  }),
);

router.post(
  "/reset-password",
  asyncHandler(async (request, response) => {
    const input = z.object({ token: z.string().min(20).max(200), password: passwordRules }).parse(request.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    await transaction(async (client) => {
      // Lock and consume the reset record in one transaction so two concurrent
      // requests cannot successfully reuse the same one-time link.
      const result = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM password_reset_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [hashToken(input.token)],
      );
      const record = result.rows[0];
      if (!record) throw new ApiError(400, "This reset link is invalid or has expired. Request a new one.", "INVALID_RESET_TOKEN");

      await client.query(
        `UPDATE users SET password_hash = $2, must_change_password = false, failed_login_attempts = 0, locked_until = NULL
          WHERE id = $1`,
        [record.user_id, passwordHash],
      );
      await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [record.id]);
      await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [record.user_id]);
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'PASSWORD_RESET','user',$1,'{}')`,
        [record.user_id],
      );
    });

    response.json({ message: "Your password has been updated. You can now sign in." });
  }),
);

router.post(
  "/change-password",
  authenticate,
  asyncHandler(async (request, response) => {
    const input = z
      .object({ currentPassword: z.string().min(1).max(128), password: passwordRules })
      .parse(request.body);
    const result = await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
      request.auth!.userId,
    ]);
    const current = result.rows[0];
    if (!current || !(await bcrypt.compare(input.currentPassword, current.password_hash))) {
      throw new ApiError(401, "Your current password is incorrect", "INVALID_CREDENTIALS");
    }
    if (await bcrypt.compare(input.password, current.password_hash)) {
      throw new ApiError(422, "Choose a password you have not used before", "PASSWORD_REUSED");
    }

    await query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [
      request.auth!.userId,
      await bcrypt.hash(input.password, 12),
    ]);
    await revokeAllRefreshTokens(request.auth!.userId);
    response.json({ message: "Password updated. Please sign in again on your other devices." });
  }),
);

/* ----------------------------------- me ----------------------------------- */

router.get(
  "/me",
  authenticate,
  asyncHandler(async (request, response) => {
    const result = await query(
      `SELECT u.id,u.email,u.full_name,u.job_title,u.phone,u.role,u.preferred_language,u.must_change_password,
              u.last_login_at,b.id AS business_id,b.name AS business_name,b.status,b.credit_limit_rwf,
              b.payment_terms_days,b.credit_hold,t.name AS price_tier
         FROM users u
         LEFT JOIN businesses b ON b.id = u.business_id
         LEFT JOIN price_tiers t ON t.id = b.price_tier_id
        WHERE u.id = $1`,
      [request.auth!.userId],
    );
    if (!result.rowCount) throw new ApiError(404, "Account not found", "NOT_FOUND");
    response.json({ data: result.rows[0] });
  }),
);

export default router;
