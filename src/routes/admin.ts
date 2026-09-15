import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { authenticate, requireRole } from "../middleware/authenticate.js";

const router = Router();
router.use(authenticate, requireRole("SUPER_ADMIN", "SALES_MANAGER"));

router.get("/registrations", asyncHandler(async (request, response) => {
  const status = z.enum(["PENDING","APPROVED","SUSPENDED","REJECTED"]).default("PENDING").parse(request.query.status);
  const result = await query(`SELECT b.id,b.name,b.type,b.registration_number,b.tin,b.pharmacy_licence_number,b.operating_licence_number,b.district,b.country,b.status,b.created_at,
    json_build_object('id',u.id,'fullName',u.full_name,'email',u.email,'phone',u.phone,'jobTitle',u.job_title) AS contact
    FROM businesses b JOIN users u ON u.business_id=b.id AND u.role='CLIENT' WHERE b.status=$1 ORDER BY b.created_at`, [status]);
  response.json({ data: result.rows });
}));

router.patch("/registrations/:id/status", asyncHandler(async (request, response) => {
  const id = z.uuid().parse(request.params.id);
  const input = z.object({ status: z.enum(["APPROVED","SUSPENDED","REJECTED","PENDING"]), reason: z.string().max(500).optional() }).parse(request.body);
  if ((input.status === "REJECTED" || input.status === "SUSPENDED") && !input.reason) throw new ApiError(422, "A reason is required", "REASON_REQUIRED");
  const result = await query(`UPDATE businesses SET status=$1,status_reason=$2,approved_at=CASE WHEN $1='APPROVED' THEN now() ELSE approved_at END WHERE id=$3 RETURNING id,name,status,status_reason,approved_at`, [input.status,input.reason ?? null,id]);
  if (!result.rowCount) throw new ApiError(404, "Registration not found", "NOT_FOUND");
  await query("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'REGISTRATION_STATUS_CHANGED','business',$2,$3)", [request.auth!.userId,id,JSON.stringify(input)]);
  response.json({ data: result.rows[0] });
}));

router.get("/clients", asyncHandler(async (_request, response) => {
  const result = await query(`SELECT b.id,b.name,b.type,b.registration_number,b.tin,b.district,b.country,b.status,
    b.credit_limit_rwf,b.payment_terms_days,b.approved_at,b.created_at,
    json_build_object('fullName',u.full_name,'email',u.email,'phone',u.phone,'jobTitle',u.job_title) AS contact,
    COUNT(DISTINCT o.id)::int AS order_count,
    COALESCE(SUM(o.total_rwf),0) AS lifetime_value_rwf
    FROM businesses b
    JOIN users u ON u.business_id=b.id AND u.role='CLIENT'
    LEFT JOIN orders o ON o.business_id=b.id
    WHERE b.status IN ('APPROVED','SUSPENDED')
    GROUP BY b.id,u.id ORDER BY b.approved_at DESC NULLS LAST,b.name`);
  response.json({ data: result.rows });
}));

router.get("/orders", asyncHandler(async (request, response) => {
  const status = z.enum(["DRAFT","SUBMITTED","PROCESSING","SHIPPED","DELIVERED","INVOICED","CANCELLED"]).optional().parse(request.query.status);
  const result = await query(`SELECT o.id,o.reference,o.status,o.purchase_order_reference,o.subtotal_rwf,o.vat_rwf,o.total_rwf,
    o.tracking_number,o.submitted_at,o.created_at,b.id AS business_id,b.name AS business_name,
    u.full_name AS created_by_name,COUNT(i.id)::int AS item_count,COALESCE(SUM(i.quantity),0)::int AS total_quantity
    FROM orders o JOIN businesses b ON b.id=o.business_id JOIN users u ON u.id=o.created_by
    LEFT JOIN order_items i ON i.order_id=o.id
    WHERE ($1::order_status IS NULL OR o.status=$1)
    GROUP BY o.id,b.id,u.id ORDER BY o.created_at DESC LIMIT 250`, [status ?? null]);
  response.json({ data: result.rows });
}));

router.patch("/orders/:id/status", asyncHandler(async (request, response) => {
  const id = z.uuid().parse(request.params.id);
  const input = z.object({ status: z.enum(["PROCESSING","SHIPPED","DELIVERED","INVOICED","CANCELLED"]), trackingNumber: z.string().max(120).optional() }).parse(request.body);
  if (input.status === "SHIPPED" && !input.trackingNumber) throw new ApiError(422, "A tracking number is required for shipped orders", "TRACKING_REQUIRED");
  const result = await query(`UPDATE orders SET status=$1,tracking_number=COALESCE($2,tracking_number) WHERE id=$3
    RETURNING id,reference,status,tracking_number,updated_at`, [input.status,input.trackingNumber ?? null,id]);
  if (!result.rowCount) throw new ApiError(404, "Order not found", "NOT_FOUND");
  await query("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'ORDER_STATUS_CHANGED','order',$2,$3)", [request.auth!.userId,id,JSON.stringify(input)]);
  response.json({ data: result.rows[0] });
}));

export default router;
