import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { authenticate } from "../middleware/authenticate.js";

const router = Router();

router.get("/brands", asyncHandler(async (_request, response) => {
  const result = await query(`SELECT id,slug,name,origin,category,descriptor_en,descriptor_fr,logo_url,hero_image_url,priority_tier
    FROM brands WHERE is_active = true ORDER BY priority_tier,name`);
  response.json({ data: result.rows });
}));

router.get("/brands/:slug/products", asyncHandler(async (request, response) => {
  const slug = z.string().min(1).parse(request.params.slug);
  const result = await query(`SELECT p.id,p.sku,p.brand_reference,p.name,p.description_en,p.description_fr,p.size,p.image_urls,b.name AS brand_name
    FROM products p JOIN brands b ON b.id=p.brand_id WHERE b.slug=$1 AND b.is_active=true AND p.is_active=true ORDER BY p.name`, [slug]);
  response.json({ data: result.rows, pricingVisible: false });
}));

router.get("/wholesale/products", authenticate, asyncHandler(async (request, response) => {
  const filters = z.object({ brand: z.string().optional(), search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(40), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
  const result = await query(`SELECT p.id,p.sku,p.brand_reference,p.name,p.description_en,p.description_fr,p.size,p.image_urls,
      p.unit_price_rwf,p.vat_included,p.minimum_order_quantity,p.case_size,p.stock_quantity,p.stock_status,b.name AS brand_name,b.slug AS brand_slug
    FROM products p JOIN brands b ON b.id=p.brand_id
    WHERE p.is_active=true AND b.is_active=true
      AND ($1::text IS NULL OR b.slug=$1)
      AND ($2::text IS NULL OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE '%'||$2||'%')
    ORDER BY b.name,p.name LIMIT $3 OFFSET $4`, [filters.brand ?? null,filters.search ?? null,filters.limit,filters.offset]);
  response.json({ data: result.rows, pricingVisible: true, limit: filters.limit, offset: filters.offset });
}));

export default router;
