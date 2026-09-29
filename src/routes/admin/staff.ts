import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, transaction } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { ApiError } from "../../lib/errors.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { revokeAllRefreshTokens, temporaryPassword } from "../../lib/auth.js";
import { mails } from "../../lib/mailer.js";
import { STAFF_ROLES } from "../../types.js";

const router = Router();
router.use(requirePermission("staff"));

const roleEnum = z.enum(["SUPER_ADMIN", "SALES_MANAGER", "CONTENT_MANAGER", "LOGISTICS", "FINANCE"]);

router.get(
  "/",
  asyncHandler(async (_request, response) => {
    const result = await query(
      `SELECT id,email,full_name,job_title,phone,role,is_active,last_login_at,must_change_password,created_at
         FROM users WHERE role = ANY($1::user_role[]) ORDER BY is_active DESC, full_name`,
      [STAFF_ROLES],
    );
    response.json({ data: result.rows });
  }),
);

/**
 * Creates a console account with a one-time password. This replaces the
 * `create-admin` shell script for every user after the first.
 */
router.post(
  "/",
  asyncHandler(async (request, response) => {
    const input = z
      .object({
        email: z.email(),
        fullName: z.string().min(2).max(150),
        jobTitle: z.string().min(2).max(100),
        phone: z.string().min(8).max(30),
        role: roleEnum,
      })
      .parse(request.body);

    const existing = await query(`SELECT id FROM users WHERE lower(email)=lower($1)`, [input.email]);
    if (existing.rowCount) throw new ApiError(409, "An account with that email already exists", "EMAIL_TAKEN");

    const password = temporaryPassword();
    const result = await query(
      `INSERT INTO users(email,password_hash,full_name,job_title,phone,role,must_change_password)
       VALUES(lower($1),$2,$3,$4,$5,$6,true)
       RETURNING id,email,full_name,job_title,phone,role,is_active,created_at`,
      [input.email, await bcrypt.hash(password, 12), input.fullName, input.jobTitle, input.phone, input.role],
    );

    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'STAFF_CREATED','user',$2,$3)`,
      [request.auth!.userId, result.rows[0]!.id as string, JSON.stringify({ role: input.role, email: input.email })],
    );
    await mails.staffInvite(input.email, input.fullName, input.role, password);

    response.status(201).json({ data: result.rows[0], message: "Invitation sent with a one-time password." });
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z
      .object({
        fullName: z.string().min(2).max(150).optional(),
        jobTitle: z.string().min(2).max(100).optional(),
        phone: z.string().min(8).max(30).optional(),
        role: roleEnum.optional(),
        isActive: z.boolean().optional(),
      })
      .parse(request.body);

    if (id === request.auth!.userId && (input.isActive === false || (input.role && input.role !== "SUPER_ADMIN"))) {
      throw new ApiError(422, "You cannot deactivate or demote your own account", "SELF_LOCKOUT");
    }

    const columns: Record<string, string> = {
      fullName: "full_name",
      jobTitle: "job_title",
      phone: "phone",
      role: "role",
      isActive: "is_active",
    };
    const entries = Object.entries(input).filter(([key]) => columns[key]);
    if (!entries.length) throw new ApiError(422, "No changes supplied", "EMPTY_UPDATE");

    const result = await transaction(async (client) => {
      // Serialize roster changes so two concurrent demotions cannot both
      // remove what each request believes is a non-final super admin.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('flr-super-admin-roster'))`);
      if (input.isActive === false || (input.role && input.role !== "SUPER_ADMIN")) {
        const remaining = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM users WHERE role='SUPER_ADMIN' AND is_active AND id <> $1`,
          [id],
        );
        const target = await client.query<{ role: string }>(`SELECT role FROM users WHERE id=$1`, [id]);
        if (target.rows[0]?.role === "SUPER_ADMIN" && Number(remaining.rows[0]!.count) === 0) {
          throw new ApiError(422, "At least one active super administrator must remain", "LAST_SUPER_ADMIN");
        }
      }

      const updated = await client.query(
        `UPDATE users SET ${entries.map(([key], index) => `${columns[key]}=$${index + 1}`).join(",")}
          WHERE id=$${entries.length + 1} AND role = ANY($${entries.length + 2}::user_role[])
          RETURNING id,email,full_name,job_title,phone,role,is_active,last_login_at`,
        [...entries.map(([, value]) => value), id, STAFF_ROLES],
      );
      if (!updated.rowCount) throw new ApiError(404, "Staff member not found", "NOT_FOUND");
      return updated;
    });

    if (input.isActive === false || input.role) await revokeAllRefreshTokens(id);
    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'STAFF_UPDATED','user',$2,$3)`,
      [request.auth!.userId, id, JSON.stringify(input)],
    );
    response.json({ data: result.rows[0] });
  }),
);

router.post(
  "/:id/reset-password",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const user = await query<{ email: string; full_name: string; role: string }>(
      `SELECT email, full_name, role FROM users WHERE id=$1 AND role = ANY($2::user_role[])`,
      [id, STAFF_ROLES],
    );
    const record = user.rows[0];
    if (!record) throw new ApiError(404, "Staff member not found", "NOT_FOUND");

    const password = temporaryPassword();
    await query(
      `UPDATE users SET password_hash=$2, must_change_password=true, failed_login_attempts=0, locked_until=NULL WHERE id=$1`,
      [id, await bcrypt.hash(password, 12)],
    );
    await revokeAllRefreshTokens(id);
    await mails.staffInvite(record.email, record.full_name, record.role, password);
    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'STAFF_PASSWORD_RESET','user',$2,'{}')`,
      [request.auth!.userId, id],
    );

    response.json({ message: `A one-time password has been emailed to ${record.email}.` });
  }),
);

/* ---------------------------------- audit ---------------------------------- */

router.get(
  "/audit-log",
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        entityType: z.string().max(60).optional(),
        action: z.string().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    const result = await query(
      `SELECT a.id,a.action,a.entity_type,a.entity_id,a.metadata,a.created_at,
              u.full_name AS actor_name,u.role AS actor_role
         FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
        WHERE ($1::text IS NULL OR a.entity_type=$1)
          AND ($2::text IS NULL OR a.action=$2)
        ORDER BY a.created_at DESC LIMIT $3`,
      [filters.entityType ?? null, filters.action ?? null, filters.limit],
    );
    response.json({ data: result.rows });
  }),
);

/** Outbound email journal — shows what was sent, and what failed to send. */
router.get(
  "/notifications",
  asyncHandler(async (request, response) => {
    const state = z.enum(["QUEUED", "SENT", "FAILED"]).optional().parse(request.query.state);
    const result = await query(
      `SELECT id,template,recipient,subject,state,error,sent_at,created_at
         FROM notifications WHERE ($1::notification_state IS NULL OR state=$1)
        ORDER BY created_at DESC LIMIT 200`,
      [state ?? null],
    );
    response.json({ data: result.rows });
  }),
);

export default router;
