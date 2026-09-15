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

export default router;
