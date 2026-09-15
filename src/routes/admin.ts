import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { authenticate, requireRole } from "../middleware/authenticate.js";

const router = Router();
router.use(authenticate, requireRole("SUPER_ADMIN", "SALES_MANAGER"));

router.get("/dashboard", asyncHandler(async (_request, response) => {
  const [metrics, monthly, recentOrders, pending, stock] = await Promise.all([
    query(`SELECT
      (SELECT COUNT(*)::int FROM businesses WHERE status='APPROVED') AS active_clients,
      (SELECT COUNT(*)::int FROM businesses WHERE status='PENDING') AS pending_applications,
      (SELECT COUNT(*)::int FROM orders WHERE status IN ('SUBMITTED','PROCESSING','SHIPPED')) AS active_orders,
      (SELECT COALESCE(SUM(total_rwf),0) FROM orders WHERE created_at >= date_trunc('month',now())) AS month_revenue_rwf,
      (SELECT COUNT(*)::int FROM products WHERE is_active=true AND stock_status IN ('LOW_STOCK','OUT_OF_STOCK')) AS stock_alerts`),
    query(`SELECT to_char(month,'Mon') AS label,COALESCE(SUM(o.total_rwf),0) AS revenue_rwf
      FROM generate_series(date_trunc('month',now())-interval '5 months',date_trunc('month',now()),interval '1 month') month
      LEFT JOIN orders o ON date_trunc('month',o.created_at)=month GROUP BY month ORDER BY month`),
    query(`SELECT o.id,o.reference,o.status,o.total_rwf,o.created_at,b.name AS business_name
      FROM orders o JOIN businesses b ON b.id=o.business_id ORDER BY o.created_at DESC LIMIT 5`),
    query(`SELECT b.id,b.name,b.type,b.created_at,u.full_name AS contact_name FROM businesses b
      JOIN users u ON u.business_id=b.id AND u.role='CLIENT' WHERE b.status='PENDING' ORDER BY b.created_at LIMIT 5`),
    query(`SELECT p.id,p.name,p.sku,p.stock_quantity,p.stock_status,b.name AS brand_name FROM products p
      JOIN brands b ON b.id=p.brand_id WHERE p.is_active=true AND p.stock_status IN ('LOW_STOCK','OUT_OF_STOCK') ORDER BY p.stock_quantity LIMIT 5`),
  ]);
  response.json({ data: { metrics: metrics.rows[0], monthlyRevenue: monthly.rows, recentOrders: recentOrders.rows, pendingApplications: pending.rows, stockAlerts: stock.rows } });
}));

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

router.get("/registrations/:id", asyncHandler(async (request, response) => {
  const id = z.uuid().parse(request.params.id);
  const business = await query(`SELECT b.*,json_build_object('id',u.id,'fullName',u.full_name,'email',u.email,'phone',u.phone,'jobTitle',u.job_title,
    'professionalLicenceNumber',u.professional_licence_number) AS contact FROM businesses b
    JOIN users u ON u.business_id=b.id AND u.role='CLIENT' WHERE b.id=$1`, [id]);
  if (!business.rowCount) throw new ApiError(404, "Registration not found", "NOT_FOUND");
  const documents = await query(`SELECT id,type,original_name,mime_type,size_bytes,verified_at,uploaded_at FROM registration_documents WHERE business_id=$1 ORDER BY uploaded_at`, [id]);
  response.json({ data: { ...business.rows[0], documents: documents.rows } });
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

router.get("/documents", asyncHandler(async (_request, response) => {
  const result = await query(`SELECT d.id,d.type,d.original_name,d.mime_type,d.size_bytes,d.verified_at,d.uploaded_at,
    b.id AS business_id,b.name AS business_name,b.status AS business_status
    FROM registration_documents d JOIN businesses b ON b.id=d.business_id
    ORDER BY d.uploaded_at DESC LIMIT 500`);
  response.json({ data: result.rows });
}));

router.patch("/clients/:id", asyncHandler(async (request, response) => {
  const id = z.uuid().parse(request.params.id);
  const input = z.object({ creditLimitRwf: z.coerce.number().min(0).max(1_000_000_000), paymentTermsDays: z.coerce.number().int().min(0).max(365), status: z.enum(["APPROVED","SUSPENDED"]), reason: z.string().max(500).optional() }).parse(request.body);
  if (input.status === "SUSPENDED" && !input.reason) throw new ApiError(422, "A suspension reason is required", "REASON_REQUIRED");
  const result = await query(`UPDATE businesses SET credit_limit_rwf=$1,payment_terms_days=$2,status=$3,status_reason=$4 WHERE id=$5
    RETURNING id,name,status,credit_limit_rwf,payment_terms_days,status_reason,updated_at`, [input.creditLimitRwf,input.paymentTermsDays,input.status,input.reason ?? null,id]);
  if (!result.rowCount) throw new ApiError(404, "Client not found", "NOT_FOUND");
  await query("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'CLIENT_TERMS_UPDATED','business',$2,$3)", [request.auth!.userId,id,JSON.stringify(input)]);
  response.json({ data: result.rows[0] });
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

router.get("/orders/:id", asyncHandler(async (request, response) => {
  const id = z.uuid().parse(request.params.id);
  const order = await query(`SELECT o.*,b.name AS business_name,b.tin,u.full_name AS created_by_name,
    CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('label',a.label,'recipientName',a.recipient_name,'phone',a.phone,'streetAddress',a.street_address,'district',a.district,'country',a.country) END AS delivery_address
    FROM orders o JOIN businesses b ON b.id=o.business_id JOIN users u ON u.id=o.created_by LEFT JOIN delivery_addresses a ON a.id=o.delivery_address_id WHERE o.id=$1`, [id]);
  if (!order.rowCount) throw new ApiError(404, "Order not found", "NOT_FOUND");
  const items = await query(`SELECT id,product_id,product_name,sku,quantity,unit_price_rwf,line_total_rwf FROM order_items WHERE order_id=$1 ORDER BY product_name`, [id]);
  response.json({ data: { ...order.rows[0], items: items.rows } });
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

const productSchema = z.object({
  brandId: z.uuid(), sku: z.string().min(2).max(100), brandReference: z.string().max(100).optional(), name: z.string().min(2).max(200),
  descriptionEn: z.string().max(3000).optional(), descriptionFr: z.string().max(3000).optional(), size: z.string().min(1).max(100),
  imageUrls: z.array(z.url()).max(8).default([]), unitPriceRwf: z.coerce.number().min(0), vatIncluded: z.boolean().default(false),
  minimumOrderQuantity: z.coerce.number().int().positive(), caseSize: z.coerce.number().int().positive(), stockQuantity: z.coerce.number().int().min(0),
  stockStatus: z.enum(["IN_STOCK","LOW_STOCK","OUT_OF_STOCK","PRE_ORDER"]), isActive: z.boolean().default(true),
});

router.get("/products", asyncHandler(async (_request, response) => {
  const result = await query(`SELECT p.id,p.brand_id,p.sku,p.brand_reference,p.name,p.description_en,p.description_fr,p.size,p.image_urls,
    p.unit_price_rwf,p.vat_included,p.minimum_order_quantity,p.case_size,p.stock_quantity,p.stock_status,p.is_active,p.updated_at,
    b.name AS brand_name,b.slug AS brand_slug
    FROM products p JOIN brands b ON b.id=p.brand_id
    ORDER BY p.is_active DESC,b.name,p.name`);
  response.json({ data: result.rows });
}));

router.post("/products", asyncHandler(async (request, response) => {
  const input = productSchema.parse(request.body);
  const result = await query(`INSERT INTO products(brand_id,sku,brand_reference,name,description_en,description_fr,size,image_urls,unit_price_rwf,vat_included,minimum_order_quantity,case_size,stock_quantity,stock_status,is_active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [input.brandId,input.sku,input.brandReference ?? null,input.name,input.descriptionEn ?? null,input.descriptionFr ?? null,input.size,input.imageUrls,input.unitPriceRwf,input.vatIncluded,input.minimumOrderQuantity,input.caseSize,input.stockQuantity,input.stockStatus,input.isActive]);
  response.status(201).json({ data: result.rows[0] });
}));

router.patch("/products/:id", asyncHandler(async (request, response) => {
  const id = z.uuid().parse(request.params.id); const input = productSchema.partial().parse(request.body);
  const entries = Object.entries(input); if (!entries.length) throw new ApiError(422, "No product changes supplied", "EMPTY_UPDATE");
  const columns: Record<string,string> = { brandId:"brand_id",sku:"sku",brandReference:"brand_reference",name:"name",descriptionEn:"description_en",descriptionFr:"description_fr",size:"size",imageUrls:"image_urls",unitPriceRwf:"unit_price_rwf",vatIncluded:"vat_included",minimumOrderQuantity:"minimum_order_quantity",caseSize:"case_size",stockQuantity:"stock_quantity",stockStatus:"stock_status",isActive:"is_active" };
  const values = entries.map(([,value])=>value); const assignments = entries.map(([key],index)=>`${columns[key]}=$${index+1}`);
  const result = await query(`UPDATE products SET ${assignments.join(",")} WHERE id=$${values.length+1} RETURNING *`, [...values,id]);
  if (!result.rowCount) throw new ApiError(404, "Product not found", "NOT_FOUND");
  response.json({ data: result.rows[0] });
}));

export default router;
