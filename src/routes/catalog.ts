import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { authenticate, requireApprovedClient } from "../middleware/authenticate.js";
import { loadPriceBreaks, resolveUnitPrice, tierDiscountFor } from "../lib/pricing.js";

const router = Router();

/* ------------------------------ public catalogue ------------------------------ */

router.get(
  "/brands",
  asyncHandler(async (_request, response) => {
    const result = await query(
      `SELECT b.id,b.slug,b.name,b.origin,b.category,b.descriptor_en,b.descriptor_fr,b.logo_url,b.hero_image_url,b.priority_tier,
              COUNT(p.id) FILTER (WHERE p.is_active) ::int AS product_count
         FROM brands b LEFT JOIN products p ON p.brand_id = b.id
        WHERE b.is_active = true
        GROUP BY b.id
        ORDER BY b.priority_tier, b.name`,
    );
    response.json({ data: result.rows });
  }),
);

router.get(
  "/categories",
  asyncHandler(async (_request, response) => {
    const result = await query(
      `SELECT COALESCE(p.category, b.category) AS category, COUNT(*)::int AS product_count
         FROM products p JOIN brands b ON b.id = p.brand_id
        WHERE p.is_active AND b.is_active
        GROUP BY 1 ORDER BY 1`,
    );
    response.json({ data: result.rows });
  }),
);

router.get(
  "/brands/:slug/products",
  asyncHandler(async (request, response) => {
    const slug = z.string().min(1).max(120).parse(request.params.slug);
    const result = await query(
      `SELECT p.id,p.sku,p.brand_reference,p.name,p.description_en,p.description_fr,p.size,p.image_urls,
              p.category,p.requires_prescription,p.cold_chain,b.name AS brand_name,b.slug AS brand_slug
         FROM products p JOIN brands b ON b.id = p.brand_id
        WHERE b.slug = $1 AND b.is_active AND p.is_active
        ORDER BY p.name`,
      [slug],
    );
    // Wholesale pricing is contractual and never leaves an authenticated session.
    response.json({ data: result.rows, pricingVisible: false });
  }),
);

/* ---------------------------- wholesale catalogue ---------------------------- */

const SORTS = {
  name: "b.name, p.name",
  "price-asc": "p.unit_price_rwf ASC, p.name",
  "price-desc": "p.unit_price_rwf DESC, p.name",
  newest: "p.created_at DESC",
} as const;

router.get(
  "/wholesale/products",
  authenticate,
  requireApprovedClient,
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        brand: z.string().max(120).optional(),
        category: z.string().max(120).optional(),
        search: z.string().max(100).optional(),
        inStockOnly: z.coerce.boolean().default(false),
        sort: z.enum(["name", "price-asc", "price-desc", "newest"]).default("name"),
        limit: z.coerce.number().int().min(1).max(100).default(40),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const businessId = request.auth!.businessId!;
    const { discountPercent, tierName } = await tierDiscountFor(businessId);

    const params = [
      filters.brand ?? null,
      filters.search ?? null,
      filters.category ?? null,
      filters.inStockOnly,
      filters.limit,
      filters.offset,
    ];

    const result = await query<Record<string, unknown>>(
      `SELECT p.id,p.sku,p.brand_reference,p.name,p.description_en,p.description_fr,p.size,p.image_urls,
              p.unit_price_rwf,p.vat_rate,p.minimum_order_quantity,p.case_size,p.stock_quantity,p.stock_status,
              p.category,p.requires_prescription,p.cold_chain,p.controlled_substance,
              b.name AS brand_name,b.slug AS brand_slug,
              (SELECT MIN(pb.expiry_date) FROM product_batches pb
                WHERE pb.product_id = p.id AND pb.quantity_remaining > 0 AND pb.recalled_at IS NULL
                  AND pb.expiry_date > CURRENT_DATE) AS earliest_expiry,
              COUNT(*) OVER()::int AS total_count
         FROM products p JOIN brands b ON b.id = p.brand_id
        WHERE p.is_active AND b.is_active
          AND ($1::text IS NULL OR b.slug = $1)
          AND ($2::text IS NULL OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE '%'||$2||'%' OR b.name ILIKE '%'||$2||'%')
          AND ($3::text IS NULL OR COALESCE(p.category, b.category) = $3)
          AND ($4::boolean = false OR p.stock_status <> 'OUT_OF_STOCK')
        ORDER BY ${SORTS[filters.sort]}
        LIMIT $5 OFFSET $6`,
      params,
    );

    const productIds = result.rows.map((row) => row.id as string);
    const breaks = await loadPriceBreaks(productIds);

    const data = result.rows.map((row) => {
      const listPrice = Number(row.unit_price_rwf);
      const productBreaks = breaks.get(row.id as string) ?? [];
      const minimumQuantity = Number(row.minimum_order_quantity);
      return {
        ...row,
        list_price_rwf: listPrice,
        // The price this client actually pays at their minimum order quantity.
        your_price_rwf: resolveUnitPrice(listPrice, productBreaks, minimumQuantity, discountPercent),
        price_breaks: productBreaks.map((entry) => ({
          minQuantity: entry.min_quantity,
          unitPriceRwf: resolveUnitPrice(Number(entry.unit_price_rwf), [], 0, discountPercent),
        })),
      };
    });

    response.json({
      data,
      pricingVisible: true,
      tier: { name: tierName, discountPercent },
      total: (result.rows[0]?.total_count as number) ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    });
  }),
);

router.get(
  "/wholesale/products/:id",
  authenticate,
  requireApprovedClient,
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const businessId = request.auth!.businessId!;
    const { discountPercent, tierName } = await tierDiscountFor(businessId);

    const result = await query<Record<string, unknown>>(
      `SELECT p.*, b.name AS brand_name, b.slug AS brand_slug, b.origin AS brand_origin,
              (SELECT MIN(pb.expiry_date) FROM product_batches pb
                WHERE pb.product_id = p.id AND pb.quantity_remaining > 0 AND pb.recalled_at IS NULL
                  AND pb.expiry_date > CURRENT_DATE) AS earliest_expiry
         FROM products p JOIN brands b ON b.id = p.brand_id
        WHERE p.id = $1 AND p.is_active AND b.is_active`,
      [id],
    );
    const product = result.rows[0];
    if (!product) throw new ApiError(404, "Product not found", "NOT_FOUND");

    const breaks = (await loadPriceBreaks([id])).get(id) ?? [];
    const listPrice = Number(product.unit_price_rwf);

    response.json({
      data: {
        ...product,
        list_price_rwf: listPrice,
        your_price_rwf: resolveUnitPrice(listPrice, breaks, Number(product.minimum_order_quantity), discountPercent),
        price_breaks: breaks.map((entry) => ({
          minQuantity: entry.min_quantity,
          unitPriceRwf: resolveUnitPrice(Number(entry.unit_price_rwf), [], 0, discountPercent),
        })),
      },
      tier: { name: tierName, discountPercent },
    });
  }),
);

export default router;
