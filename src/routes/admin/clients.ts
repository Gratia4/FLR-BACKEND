import { Router } from "express";
import { z } from "zod";
import { query } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { ApiError } from "../../lib/errors.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { creditPosition } from "../../lib/credit.js";
import { mails } from "../../lib/mailer.js";

const router = Router();
router.use(requirePermission("clients"));

router.get(
  "/",
  asyncHandler(async (request, response) => {
    const filters = z
      .object({ status: z.enum(["APPROVED", "SUSPENDED"]).optional(), search: z.string().max(100).optional() })
      .parse(request.query);

    const result = await query(
      `SELECT b.id,b.name,b.type,b.registration_number,b.tin,b.district,b.country,b.status,
              b.credit_limit_rwf,b.payment_terms_days,b.credit_hold,b.approved_at,b.created_at,
              t.id AS price_tier_id, t.name AS price_tier, t.discount_percent,
              am.id AS account_manager_id, am.full_name AS account_manager_name,
              json_build_object('fullName',u.full_name,'email',u.email,'phone',u.phone,'jobTitle',u.job_title) AS contact,
              COUNT(DISTINCT o.id)::int AS order_count,
              COALESCE(SUM(o.total_rwf) FILTER (WHERE o.status <> 'CANCELLED'),0) AS lifetime_value_rwf,
              MAX(o.created_at) AS last_order_at,
              COALESCE((SELECT SUM(i.total_rwf - i.amount_paid_rwf) FROM invoices i
                         WHERE i.business_id = b.id AND i.status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')),0) AS outstanding_rwf,
              COALESCE((SELECT SUM(i.total_rwf - i.amount_paid_rwf) FROM invoices i
                         WHERE i.business_id = b.id AND i.status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')
                           AND i.due_at < now()),0) AS overdue_rwf
         FROM businesses b
         JOIN users u ON u.business_id = b.id AND u.role='CLIENT'
         LEFT JOIN price_tiers t ON t.id = b.price_tier_id
         LEFT JOIN orders o ON o.business_id = b.id
         LEFT JOIN users am ON am.id = b.assigned_account_manager_id
        WHERE b.status IN ('APPROVED','SUSPENDED')
          AND ($1::account_status IS NULL OR b.status = $1)
          AND ($2::text IS NULL OR b.name ILIKE '%'||$2||'%' OR b.tin ILIKE '%'||$2||'%' OR u.email ILIKE '%'||$2||'%')
        GROUP BY b.id, u.id, t.id, am.id
        ORDER BY lifetime_value_rwf DESC, b.name`,
      [filters.status ?? null, filters.search ?? null],
    );
    response.json({ data: result.rows });
  }),
);

router.get(
  "/tiers",
  asyncHandler(async (_request, response) => {
    const result = await query(`SELECT id,code,name,discount_percent,minimum_monthly_rwf,is_default FROM price_tiers ORDER BY discount_percent`);
    response.json({ data: result.rows });
  }),
);

router.get(
  "/account-managers",
  asyncHandler(async (_request, response) => {
    const result = await query(
      `SELECT id,full_name,email,role FROM users
        WHERE is_active AND role IN ('SUPER_ADMIN','SALES_MANAGER')
        ORDER BY full_name`,
    );
    response.json({ data: result.rows });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const business = await query(
      `SELECT b.*, t.name AS price_tier, t.discount_percent,
              am.full_name AS account_manager_name, am.email AS account_manager_email,
              json_build_object('fullName',u.full_name,'email',u.email,'phone',u.phone,'jobTitle',u.job_title) AS contact
         FROM businesses b
         JOIN users u ON u.business_id=b.id AND u.role='CLIENT'
         LEFT JOIN price_tiers t ON t.id=b.price_tier_id
         LEFT JOIN users am ON am.id=b.assigned_account_manager_id
        WHERE b.id=$1`,
      [id],
    );
    if (!business.rowCount) throw new ApiError(404, "Client not found", "NOT_FOUND");

    const [orders, invoices, addresses, notes, credit] = await Promise.all([
      query(
        `SELECT id,reference,status,total_rwf,created_at FROM orders WHERE business_id=$1 ORDER BY created_at DESC LIMIT 10`,
        [id],
      ),
      query(
        `SELECT id,reference,status,total_rwf,amount_paid_rwf,due_at,issued_at FROM invoices WHERE business_id=$1 ORDER BY issued_at DESC LIMIT 10`,
        [id],
      ),
      query(`SELECT id,label,recipient_name,street_address,district,country,is_default FROM delivery_addresses WHERE business_id=$1`, [id]),
      query(
        `SELECT n.id,n.note,n.created_at,u.full_name AS author_name,u.role AS author_role
           FROM client_account_notes n LEFT JOIN users u ON u.id=n.author_user_id
          WHERE n.business_id=$1 ORDER BY n.created_at DESC LIMIT 50`,
        [id],
      ),
      creditPosition(id),
    ]);

    response.json({
      data: { ...business.rows[0], recentOrders: orders.rows, invoices: invoices.rows, addresses: addresses.rows, notes: notes.rows, credit },
    });
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z
      .object({
        creditLimitRwf: z.coerce.number().min(0).max(1_000_000_000).optional(),
        paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
        priceTierId: z.uuid().nullable().optional(),
        creditHold: z.boolean().optional(),
        status: z.enum(["APPROVED", "SUSPENDED"]).optional(),
        reason: z.string().max(500).optional(),
        accountManagerId: z.uuid().nullable().optional(),
      })
      .parse(request.body);

    if (input.status === "SUSPENDED" && !input.reason?.trim()) {
      throw new ApiError(422, "A suspension reason is required", "REASON_REQUIRED");
    }

    const result = await query<{ id: string; name: string; status: string }>(
      `UPDATE businesses
          SET credit_limit_rwf   = COALESCE($2, credit_limit_rwf),
              payment_terms_days = COALESCE($3, payment_terms_days),
              price_tier_id      = COALESCE($4, price_tier_id),
              credit_hold        = COALESCE($5, credit_hold),
              status             = COALESCE($6, status),
              status_reason      = COALESCE($7, status_reason),
              assigned_account_manager_id = CASE WHEN $8::boolean THEN $9::uuid ELSE assigned_account_manager_id END
        WHERE id = $1
        RETURNING id,name,status,credit_limit_rwf,payment_terms_days,credit_hold,price_tier_id,status_reason,assigned_account_manager_id,updated_at`,
      [
        id,
        input.creditLimitRwf ?? null,
        input.paymentTermsDays ?? null,
        input.priceTierId ?? null,
        input.creditHold ?? null,
        input.status ?? null,
        input.reason ?? null,
        Object.prototype.hasOwnProperty.call(input, "accountManagerId"),
        input.accountManagerId ?? null,
      ],
    );
    if (!result.rowCount) throw new ApiError(404, "Client not found", "NOT_FOUND");

    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'CLIENT_TERMS_UPDATED','business',$2,$3)`,
      [request.auth!.userId, id, JSON.stringify(input)],
    );

    if (input.status === "SUSPENDED") {
      const contact = await query<{ email: string; full_name: string }>(
        `SELECT email, full_name FROM users WHERE business_id=$1 AND role='CLIENT' LIMIT 1`,
        [id],
      );
      if (contact.rows[0]) {
        await mails.accountSuspended(contact.rows[0].email, contact.rows[0].full_name, result.rows[0]!.name, input.reason!);
      }
    }

    response.json({ data: result.rows[0] });
  }),
);

router.post(
  "/:id/notes",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const { note } = z.object({ note: z.string().trim().min(2).max(2000) }).parse(request.body);
    const result = await query(
      `WITH inserted AS (
         INSERT INTO client_account_notes(business_id,author_user_id,note)
         SELECT b.id,$2,$3 FROM businesses b WHERE b.id=$1
         RETURNING id,author_user_id,note,created_at
       )
       SELECT i.id,i.note,i.created_at,u.full_name AS author_name,u.role AS author_role
         FROM inserted i LEFT JOIN users u ON u.id=i.author_user_id`,
      [id, request.auth!.userId, note],
    );
    if (!result.rowCount) throw new ApiError(404, "Client not found", "NOT_FOUND");
    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'CLIENT_NOTE_ADDED','business',$2,$3)`,
      [request.auth!.userId, id, JSON.stringify({ noteId: result.rows[0]!.id })],
    );
    response.status(201).json({ data: result.rows[0] });
  }),
);

export default router;
