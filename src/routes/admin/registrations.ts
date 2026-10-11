import { Router } from "express";
import { z } from "zod";
import { query } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { ApiError } from "../../lib/errors.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { mails } from "../../lib/mailer.js";

const router = Router();
router.use(requirePermission("registrations"));

router.get(
  "/",
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        status: z.enum(["PENDING", "APPROVED", "SUSPENDED", "REJECTED"]).optional(),
        search: z.string().max(100).optional(),
      })
      .parse(request.query);

    const result = await query(
      `SELECT b.id,b.name,b.type,b.registration_number,b.tin,b.pharmacy_licence_number,b.operating_licence_number,
              b.vat_registration_number,b.street_address,b.district,b.country,b.status,b.status_reason,b.created_at,
              json_build_object('id',u.id,'fullName',u.full_name,'email',u.email,'phone',u.phone,'jobTitle',u.job_title) AS contact,
              COUNT(d.id)::int AS document_count,
              COUNT(d.id) FILTER (WHERE d.verified_at IS NOT NULL)::int AS verified_document_count
         FROM businesses b
         JOIN users u ON u.business_id = b.id AND u.role = 'CLIENT'
         LEFT JOIN registration_documents d ON d.business_id = b.id
        WHERE ($1::account_status IS NULL OR b.status = $1)
          AND ($2::text IS NULL OR b.name ILIKE '%'||$2||'%' OR b.tin ILIKE '%'||$2||'%' OR u.email ILIKE '%'||$2||'%')
        GROUP BY b.id, u.id
        ORDER BY (b.status = 'PENDING') DESC, b.created_at DESC`,
      [filters.status ?? null, filters.search ?? null],
    );
    response.json({ data: result.rows });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const business = await query(
      `SELECT b.*, t.name AS price_tier,
              json_build_object('id',u.id,'fullName',u.full_name,'email',u.email,'phone',u.phone,
                                'jobTitle',u.job_title,'professionalLicenceNumber',u.professional_licence_number,
                                'preferredLanguage',u.preferred_language) AS contact
         FROM businesses b
         JOIN users u ON u.business_id = b.id AND u.role = 'CLIENT'
         LEFT JOIN price_tiers t ON t.id = b.price_tier_id
        WHERE b.id = $1`,
      [id],
    );
    if (!business.rowCount) throw new ApiError(404, "Registration not found", "NOT_FOUND");

    const documents = await query(
      `SELECT d.id,d.type,d.original_name,d.mime_type,d.size_bytes,d.provider,d.verified_at,d.rejection_reason,
              d.uploaded_at, v.full_name AS verified_by_name
         FROM registration_documents d
         LEFT JOIN users v ON v.id = d.verified_by
        WHERE d.business_id = $1 ORDER BY d.uploaded_at`,
      [id],
    );
    const history = await query(
      `SELECT action, metadata, created_at, (SELECT full_name FROM users WHERE id = actor_user_id) AS actor
         FROM audit_logs WHERE entity_type='business' AND entity_id=$1 ORDER BY created_at DESC LIMIT 25`,
      [id],
    );
    response.json({ data: { ...business.rows[0], documents: documents.rows, history: history.rows } });
  }),
);

router.patch(
  "/:id/status",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z
      .object({
        status: z.enum(["APPROVED", "SUSPENDED", "REJECTED", "PENDING"]),
        reason: z.string().max(500).optional(),
        creditLimitRwf: z.coerce.number().min(0).max(1_000_000_000).optional(),
        paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
      })
      .parse(request.body);

    if ((input.status === "REJECTED" || input.status === "SUSPENDED") && !input.reason?.trim()) {
      throw new ApiError(422, "A reason is required when rejecting or suspending an account", "REASON_REQUIRED");
    }

    const result = await query<{ id: string; name: string; status: string }>(
      `UPDATE businesses
          SET status=$1::account_status,
              status_reason=$2,
              approved_at = CASE WHEN $1::account_status='APPROVED' AND approved_at IS NULL THEN now() ELSE approved_at END,
              credit_limit_rwf = COALESCE($4, credit_limit_rwf),
              payment_terms_days = COALESCE($5, payment_terms_days)
        WHERE id=$3
        RETURNING id,name,status,status_reason,approved_at,credit_limit_rwf,payment_terms_days`,
      [input.status, input.reason ?? null, id, input.creditLimitRwf ?? null, input.paymentTermsDays ?? null],
    );
    if (!result.rowCount) throw new ApiError(404, "Registration not found", "NOT_FOUND");

    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'REGISTRATION_STATUS_CHANGED','business',$2,$3)`,
      [request.auth!.userId, id, JSON.stringify(input)],
    );

    const contact = await query<{ email: string; full_name: string }>(
      `SELECT email, full_name FROM users WHERE business_id=$1 AND role='CLIENT' LIMIT 1`,
      [id],
    );
    const person = contact.rows[0];
    const business = result.rows[0]!;
    if (person) {
      if (input.status === "APPROVED") await mails.accountApproved(person.email, person.full_name, business.name);
      if (input.status === "REJECTED") await mails.accountRejected(person.email, person.full_name, business.name, input.reason!);
      if (input.status === "SUSPENDED") await mails.accountSuspended(person.email, person.full_name, business.name, input.reason!);
    }

    response.json({ data: business });
  }),
);

router.post(
  "/:id/request-info",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);

    const result = await query<{ name: string; email: string; full_name: string }>(
      `UPDATE businesses b
          SET status='PENDING', status_reason=$2
         FROM users u
        WHERE b.id=$1 AND u.business_id=b.id AND u.role='CLIENT'
        RETURNING b.name,u.email,u.full_name`,
      [id, input.reason],
    );
    const record = result.rows[0];
    if (!record) throw new ApiError(404, "Registration not found", "NOT_FOUND");

    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'REGISTRATION_MORE_INFO_REQUESTED','business',$2,$3)`,
      [request.auth!.userId, id, JSON.stringify(input)],
    );
    await mails.accountMoreInfo(record.email, record.full_name, record.name, input.reason);
    response.json({ message: "The client has been asked for more information." });
  }),
);

export default router;
