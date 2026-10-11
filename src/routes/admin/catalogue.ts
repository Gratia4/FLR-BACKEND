import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { ApiError } from "../../lib/errors.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { detectImageType, PRODUCT_IMAGE_PREFIX, productImageName, productImageUpload, productImageUrl } from "../../lib/product-images.js";
import { putObject } from "../../lib/storage.js";

const router = Router();

const productSchema = z.object({
  brandId: z.uuid(),
  sku: z.string().min(2).max(100),
  brandReference: z.string().max(100).optional(),
  name: z.string().min(2).max(200),
  descriptionEn: z.string().max(3000).optional(),
  descriptionFr: z.string().max(3000).optional(),
  category: z.string().max(100).optional(),
  size: z.string().min(1).max(100),
  imageUrls: z.array(z.url()).max(8).default([]),
  unitPriceRwf: z.coerce.number().min(0),
  vatRate: z.coerce.number().min(0).max(1).default(0.18),
  minimumOrderQuantity: z.coerce.number().int().positive(),
  caseSize: z.coerce.number().int().positive(),
  stockQuantity: z.coerce.number().int().min(0),
  reorderLevel: z.coerce.number().int().min(0).default(0),
  stockStatus: z.enum(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "PRE_ORDER"]),
  requiresPrescription: z.boolean().default(false),
  coldChain: z.boolean().default(false),
  controlledSubstance: z.boolean().default(false),
  shelfLifeDays: z.coerce.number().int().positive().optional(),
  isActive: z.boolean().default(true),
  priceBreaks: z
    .array(z.object({ minQuantity: z.coerce.number().int().min(2), unitPriceRwf: z.coerce.number().min(0) }))
    .max(5)
    .default([]),
});

const COLUMNS: Record<string, string> = {
  brandId: "brand_id",
  sku: "sku",
  brandReference: "brand_reference",
  name: "name",
  descriptionEn: "description_en",
  descriptionFr: "description_fr",
  category: "category",
  size: "size",
  imageUrls: "image_urls",
  unitPriceRwf: "unit_price_rwf",
  vatRate: "vat_rate",
  minimumOrderQuantity: "minimum_order_quantity",
  caseSize: "case_size",
  stockQuantity: "stock_quantity",
  reorderLevel: "reorder_level",
  stockStatus: "stock_status",
  requiresPrescription: "requires_prescription",
  coldChain: "cold_chain",
  controlledSubstance: "controlled_substance",
  shelfLifeDays: "shelf_life_days",
  isActive: "is_active",
};

const PRODUCT_SELECT = `
  SELECT p.id,p.brand_id,p.sku,p.brand_reference,p.name,p.description_en,p.description_fr,p.category,p.size,
         p.image_urls,p.unit_price_rwf,p.vat_rate::float AS vat_rate,p.minimum_order_quantity,p.case_size,p.stock_quantity,
         p.reorder_level,p.stock_status,p.requires_prescription,p.cold_chain,p.controlled_substance,
         p.shelf_life_days,p.is_active,p.updated_at,
         b.name AS brand_name,b.slug AS brand_slug,
         COALESCE((SELECT json_agg(json_build_object('minQuantity',min_quantity,'unitPriceRwf',unit_price_rwf)
                                   ORDER BY min_quantity)
                     FROM product_price_breaks WHERE product_id=p.id),'[]') AS price_breaks,
         COALESCE((SELECT SUM(quantity_remaining)::int FROM product_batches
                    WHERE product_id=p.id AND quantity_remaining>0 AND recalled_at IS NULL
                      AND expiry_date > CURRENT_DATE),0) AS batched_quantity,
         (SELECT MIN(expiry_date) FROM product_batches
           WHERE product_id=p.id AND quantity_remaining>0 AND recalled_at IS NULL AND expiry_date > CURRENT_DATE) AS earliest_expiry
    FROM products p JOIN brands b ON b.id=p.brand_id`;

/* --------------------------------- products -------------------------------- */

router.get(
  "/products",
  requirePermission("inventory"),
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        brand: z.string().max(120).optional(),
        search: z.string().max(100).optional(),
        status: z.enum(["active", "inactive", "all"]).default("all"),
      })
      .parse(request.query);

    const result = await query(
      `${PRODUCT_SELECT}
        WHERE ($1::text IS NULL OR b.slug=$1)
          AND ($2::text IS NULL OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE '%'||$2||'%')
          AND ($3='all' OR ($3='active' AND p.is_active) OR ($3='inactive' AND NOT p.is_active))
        ORDER BY p.is_active DESC, b.name, p.name`,
      [filters.brand ?? null, filters.search ?? null, filters.status],
    );
    response.json({ data: result.rows });
  }),
);

router.get(
  "/products/:id",
  requirePermission("inventory"),
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const result = await query(`${PRODUCT_SELECT} WHERE p.id=$1`, [id]);
    if (!result.rowCount) throw new ApiError(404, "Product not found", "NOT_FOUND");
    response.json({ data: result.rows[0] });
  }),
);

/** Stores one product photo and returns its public URL for the product's imageUrls. */
router.post(
  "/products/images",
  requirePermission("catalogue"),
  productImageUpload,
  asyncHandler(async (request, response) => {
    const file = request.file;
    if (!file) throw new ApiError(422, "Choose an image to upload", "IMAGE_REQUIRED");
    const type = detectImageType(file.buffer);
    if (!type) throw new ApiError(415, `${file.originalname} is not a valid JPG, PNG or WebP image`, "UNSUPPORTED_FILE_TYPE");
    const name = productImageName(type);
    await putObject(`${PRODUCT_IMAGE_PREFIX}${name}`, file.buffer, type);
    response.status(201).json({ data: { url: productImageUrl(request, name), sizeBytes: file.size } });
  }),
);

router.post(
  "/products",
  requirePermission("catalogue"),
  asyncHandler(async (request, response) => {
    const input = productSchema.parse(request.body);

    const created = await transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO products(brand_id,sku,brand_reference,name,description_en,description_fr,category,size,image_urls,
                              unit_price_rwf,vat_rate,minimum_order_quantity,case_size,stock_quantity,reorder_level,
                              stock_status,requires_prescription,cold_chain,controlled_substance,shelf_life_days,is_active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
        [
          input.brandId, input.sku, input.brandReference ?? null, input.name, input.descriptionEn ?? null,
          input.descriptionFr ?? null, input.category ?? null, input.size, input.imageUrls, input.unitPriceRwf,
          input.vatRate, input.minimumOrderQuantity, input.caseSize, input.stockQuantity, input.reorderLevel,
          input.stockStatus, input.requiresPrescription, input.coldChain, input.controlledSubstance,
          input.shelfLifeDays ?? null, input.isActive,
        ],
      );
      const id = result.rows[0]!.id;
      await writePriceBreaks(client, id, input.priceBreaks);

      if (input.stockQuantity > 0) {
        await client.query(
          `INSERT INTO stock_movements(product_id,reason,quantity_delta,balance_after,reference_type,reference_id,actor_user_id,note)
           VALUES($1,'RECEIPT',$2,$2,'product',$1,$3,'Opening stock')`,
          [id, input.stockQuantity, request.auth!.userId],
        );
      }
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'PRODUCT_CREATED','product',$2,$3)`,
        [request.auth!.userId, id, JSON.stringify({ sku: input.sku, name: input.name })],
      );
      return id;
    });

    const result = await query(`${PRODUCT_SELECT} WHERE p.id=$1`, [created]);
    response.status(201).json({ data: result.rows[0] });
  }),
);

router.patch(
  "/products/:id",
  requirePermission("catalogue"),
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = productSchema.partial().parse(request.body);
    const { priceBreaks, ...fields } = input;

    await transaction(async (client) => {
      const entries = Object.entries(fields).filter(([key]) => COLUMNS[key]);

      if (entries.length) {
        // Stock corrections go through the ledger so the movement history stays truthful.
        if (fields.stockQuantity !== undefined) {
          const before = await client.query<{ stock_quantity: number }>(
            `SELECT stock_quantity FROM products WHERE id=$1 FOR UPDATE`,
            [id],
          );
          if (!before.rowCount) throw new ApiError(404, "Product not found", "NOT_FOUND");
          const delta = fields.stockQuantity - before.rows[0]!.stock_quantity;
          if (delta !== 0) {
            await client.query(
              `INSERT INTO stock_movements(product_id,reason,quantity_delta,balance_after,reference_type,reference_id,actor_user_id,note)
               VALUES($1,'ADJUSTMENT',$2,$3,'product',$1,$4,'Manual catalogue adjustment')`,
              [id, delta, fields.stockQuantity, request.auth!.userId],
            );
          }
        }

        const assignments = entries.map(([key], index) => `${COLUMNS[key]}=$${index + 1}`);
        const values = entries.map(([, value]) => value);
        const result = await client.query(
          `UPDATE products SET ${assignments.join(",")} WHERE id=$${values.length + 1} RETURNING id`,
          [...values, id],
        );
        if (!result.rowCount) throw new ApiError(404, "Product not found", "NOT_FOUND");
      }

      if (priceBreaks) await writePriceBreaks(client, id, priceBreaks);

      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'PRODUCT_UPDATED','product',$2,$3)`,
        [request.auth!.userId, id, JSON.stringify(Object.keys(input))],
      );
    });

    const result = await query(`${PRODUCT_SELECT} WHERE p.id=$1`, [id]);
    response.json({ data: result.rows[0] });
  }),
);

async function writePriceBreaks(
  client: import("pg").PoolClient,
  productId: string,
  breaks: Array<{ minQuantity: number; unitPriceRwf: number }>,
) {
  await client.query(`DELETE FROM product_price_breaks WHERE product_id=$1`, [productId]);
  for (const entry of breaks) {
    await client.query(
      `INSERT INTO product_price_breaks(product_id,min_quantity,unit_price_rwf) VALUES($1,$2,$3)`,
      [productId, entry.minQuantity, entry.unitPriceRwf],
    );
  }
}

/* ---------------------------------- brands --------------------------------- */

const brandSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and hyphens"),
  name: z.string().min(2).max(120),
  origin: z.string().min(2).max(120),
  category: z.string().min(2).max(120),
  descriptorEn: z.string().max(600).optional(),
  descriptorFr: z.string().max(600).optional(),
  logoUrl: z.url().optional(),
  heroImageUrl: z.url().optional(),
  priorityTier: z.coerce.number().int().min(1).max(3).default(3),
  isActive: z.boolean().default(true),
});

router.post(
  "/brands",
  requirePermission("catalogue"),
  asyncHandler(async (request, response) => {
    const input = brandSchema.parse(request.body);
    const result = await query(
      `INSERT INTO brands(slug,name,origin,category,descriptor_en,descriptor_fr,logo_url,hero_image_url,priority_tier,is_active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        input.slug, input.name, input.origin, input.category, input.descriptorEn ?? null, input.descriptorFr ?? null,
        input.logoUrl ?? null, input.heroImageUrl ?? null, input.priorityTier, input.isActive,
      ],
    );
    response.status(201).json({ data: result.rows[0] });
  }),
);

router.patch(
  "/brands/:id",
  requirePermission("catalogue"),
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = brandSchema.partial().parse(request.body);
    const columns: Record<string, string> = {
      slug: "slug", name: "name", origin: "origin", category: "category",
      descriptorEn: "descriptor_en", descriptorFr: "descriptor_fr",
      logoUrl: "logo_url", heroImageUrl: "hero_image_url",
      priorityTier: "priority_tier", isActive: "is_active",
    };
    const entries = Object.entries(input).filter(([key]) => columns[key]);
    if (!entries.length) throw new ApiError(422, "No brand changes supplied", "EMPTY_UPDATE");

    const result = await query(
      `UPDATE brands SET ${entries.map(([key], index) => `${columns[key]}=$${index + 1}`).join(",")}
        WHERE id=$${entries.length + 1} RETURNING *`,
      [...entries.map(([, value]) => value), id],
    );
    if (!result.rowCount) throw new ApiError(404, "Brand not found", "NOT_FOUND");
    response.json({ data: result.rows[0] });
  }),
);

/* ------------------------------ bulk price import --------------------------- */

router.post(
  "/products/bulk-price",
  requirePermission("catalogue"),
  asyncHandler(async (request, response) => {
    const input = z
      .object({
        updates: z
          .array(z.object({ sku: z.string().min(1).max(100), unitPriceRwf: z.coerce.number().min(0) }))
          .min(1)
          .max(500),
      })
      .parse(request.body);

    const outcome = await transaction(async (client) => {
      const updated: string[] = [];
      const missing: string[] = [];
      for (const row of input.updates) {
        const result = await client.query(`UPDATE products SET unit_price_rwf=$1 WHERE sku=$2 RETURNING sku`, [
          row.unitPriceRwf,
          row.sku,
        ]);
        result.rowCount ? updated.push(row.sku) : missing.push(row.sku);
      }
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'PRICE_LIST_IMPORTED','product',NULL,$2)`,
        [request.auth!.userId, JSON.stringify({ updated: updated.length, missing: missing.length })],
      );
      return { updated, missing };
    });

    response.json({ data: outcome });
  }),
);

export default router;
