import { Router } from "express";
import { z } from "zod";
import { transaction, query } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { createReference } from "../lib/reference.js";
import { authenticate } from "../middleware/authenticate.js";

const router = Router();
router.use(authenticate);

const orderSchema = z.object({
  deliveryAddressId: z.uuid().optional(), purchaseOrderReference: z.string().max(100).optional(), notes: z.string().max(1000).optional(),
  items: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().positive() })).min(1).max(100),
});

router.post("/", asyncHandler(async (request, response) => {
  const auth = request.auth;
  if (!auth?.businessId) throw new ApiError(403, "A client business account is required", "CLIENT_ONLY");
  const input = orderSchema.parse(request.body);
  const reference = createReference("ORD");
  const order = await transaction(async (client) => {
    const ids = input.items.map((item) => item.productId);
    const products = await client.query<{id:string;sku:string;name:string;unit_price_rwf:string;minimum_order_quantity:number;stock_quantity:number;stock_status:string}>(
      `SELECT id,sku,name,unit_price_rwf,minimum_order_quantity,stock_quantity,stock_status FROM products WHERE id=ANY($1::uuid[]) AND is_active=true FOR UPDATE`, [ids]);
    if (products.rows.length !== new Set(ids).size) throw new ApiError(422, "One or more products are unavailable", "PRODUCT_UNAVAILABLE");
    let subtotal = 0;
    const lines = input.items.map((item) => {
      const product = products.rows.find((candidate) => candidate.id === item.productId)!;
      if (item.quantity < product.minimum_order_quantity) throw new ApiError(422, `${product.name} requires a minimum quantity of ${product.minimum_order_quantity}`, "MOQ_NOT_MET");
      if (product.stock_status !== "PRE_ORDER" && item.quantity > product.stock_quantity) throw new ApiError(422, `Insufficient stock for ${product.name}`, "INSUFFICIENT_STOCK");
      const unitPrice = Number(product.unit_price_rwf); const lineTotal = unitPrice * item.quantity; subtotal += lineTotal;
      return { ...item, product, unitPrice, lineTotal };
    });
    const created = await client.query<{id:string}>(`INSERT INTO orders
      (reference,business_id,created_by,delivery_address_id,status,purchase_order_reference,notes,subtotal_rwf,total_rwf,submitted_at)
      VALUES($1,$2,$3,$4,'SUBMITTED',$5,$6,$7,$7,now()) RETURNING id`, [reference,auth.businessId,auth.userId,input.deliveryAddressId ?? null,input.purchaseOrderReference ?? null,input.notes ?? null,subtotal]);
    for (const line of lines) {
      await client.query(`INSERT INTO order_items(order_id,product_id,product_name,sku,quantity,unit_price_rwf,line_total_rwf) VALUES($1,$2,$3,$4,$5,$6,$7)`, [created.rows[0]!.id,line.product.id,line.product.name,line.product.sku,line.quantity,line.unitPrice,line.lineTotal]);
      if (line.product.stock_status !== "PRE_ORDER") await client.query("UPDATE products SET stock_quantity=stock_quantity-$1 WHERE id=$2", [line.quantity,line.product.id]);
    }
    await client.query("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'ORDER_SUBMITTED','order',$2,$3)", [auth.userId,created.rows[0]!.id,JSON.stringify({reference})]);
    return created.rows[0]!.id;
  });
  response.status(201).json({ id: order, reference, status: "SUBMITTED" });
}));

router.get("/", asyncHandler(async (request, response) => {
  if (!request.auth?.businessId) throw new ApiError(403, "A client business account is required", "CLIENT_ONLY");
  const result = await query(`SELECT o.id,o.reference,o.status,o.purchase_order_reference,o.subtotal_rwf,o.vat_rwf,o.total_rwf,o.tracking_number,o.submitted_at,o.created_at,
    COALESCE(json_agg(json_build_object('productId',i.product_id,'name',i.product_name,'sku',i.sku,'quantity',i.quantity,'unitPriceRwf',i.unit_price_rwf,'lineTotalRwf',i.line_total_rwf)) FILTER (WHERE i.id IS NOT NULL),'[]') AS items
    FROM orders o LEFT JOIN order_items i ON i.order_id=o.id WHERE o.business_id=$1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100`, [request.auth.businessId]);
  response.json({ data: result.rows });
}));

export default router;
