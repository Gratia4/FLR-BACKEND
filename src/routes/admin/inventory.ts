import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { query, transaction } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { ApiError } from "../../lib/errors.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { adjustStock } from "../../lib/inventory.js";

const router = Router();
// This router is mounted without a path prefix (see ./index.ts), so a
// router-wide guard would also block unrelated admin routes for staff without
// "inventory" access. The guard is therefore applied to each route below.
const guard = requirePermission("inventory");

/* --------------------------------- overview -------------------------------- */

router.get(
  "/inventory",
  guard,
  asyncHandler(async (request, response) => {
    const days = z.coerce.number().int().positive().max(730).default(config.EXPIRY_ALERT_DAYS).parse(
      request.query.expiryWindowDays ?? config.EXPIRY_ALERT_DAYS,
    );

    const [metrics, lowStock, expiring, expired] = await Promise.all([
      query(
        `SELECT
           (SELECT COUNT(*)::int FROM products WHERE is_active) AS active_products,
           (SELECT COUNT(*)::int FROM products WHERE is_active AND stock_status='OUT_OF_STOCK') AS out_of_stock,
           (SELECT COUNT(*)::int FROM products WHERE is_active AND stock_status='LOW_STOCK') AS low_stock,
           (SELECT COALESCE(SUM(stock_quantity * unit_price_rwf),0) FROM products WHERE is_active) AS stock_value_rwf,
           (SELECT COUNT(*)::int FROM product_batches WHERE quantity_remaining>0 AND recalled_at IS NULL
              AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1||' days')::interval) AS expiring_batches,
           (SELECT COUNT(*)::int FROM product_batches WHERE quantity_remaining>0 AND expiry_date < CURRENT_DATE) AS expired_batches,
           (SELECT COALESCE(SUM(pb.quantity_remaining * p.unit_price_rwf),0) FROM product_batches pb
              JOIN products p ON p.id=pb.product_id WHERE pb.quantity_remaining>0 AND pb.expiry_date < CURRENT_DATE) AS expired_value_rwf`,
        [String(days)],
      ),
      query(
        `SELECT p.id,p.name,p.sku,p.stock_quantity,p.reorder_level,p.stock_status,p.unit_price_rwf,b.name AS brand_name
           FROM products p JOIN brands b ON b.id=p.brand_id
          WHERE p.is_active AND p.stock_status IN ('LOW_STOCK','OUT_OF_STOCK')
          ORDER BY p.stock_quantity, p.name LIMIT 50`,
      ),
      query(
        `SELECT pb.id,pb.batch_number,pb.expiry_date,pb.quantity_remaining,
                (pb.expiry_date - CURRENT_DATE)::int AS days_remaining,
                p.id AS product_id,p.name AS product_name,p.sku,p.unit_price_rwf,b.name AS brand_name
           FROM product_batches pb
           JOIN products p ON p.id=pb.product_id
           JOIN brands b ON b.id=p.brand_id
          WHERE pb.quantity_remaining>0 AND pb.recalled_at IS NULL
            AND pb.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1||' days')::interval
          ORDER BY pb.expiry_date LIMIT 100`,
        [String(days)],
      ),
      query(
        `SELECT pb.id,pb.batch_number,pb.expiry_date,pb.quantity_remaining,
                p.id AS product_id,p.name AS product_name,p.sku,b.name AS brand_name
           FROM product_batches pb
           JOIN products p ON p.id=pb.product_id
           JOIN brands b ON b.id=p.brand_id
          WHERE pb.quantity_remaining>0 AND pb.expiry_date < CURRENT_DATE
          ORDER BY pb.expiry_date LIMIT 100`,
      ),
    ]);

    response.json({
      data: {
        metrics: metrics.rows[0],
        lowStock: lowStock.rows,
        expiringBatches: expiring.rows,
        expiredBatches: expired.rows,
        expiryWindowDays: days,
      },
    });
  }),
);

/* --------------------------------- batches --------------------------------- */

router.get(
  "/batches",
  guard,
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        productId: z.uuid().optional(),
        search: z.string().max(100).optional(),
        includeDepleted: z.coerce.boolean().default(false),
      })
      .parse(request.query);

    const result = await query(
      `SELECT pb.id,pb.product_id,pb.batch_number,pb.expiry_date,pb.manufactured_on,pb.quantity_received,
              pb.quantity_remaining,pb.supplier,pb.received_at,pb.recalled_at,pb.recall_reason,
              (pb.expiry_date - CURRENT_DATE)::int AS days_remaining,
              p.name AS product_name,p.sku,b.name AS brand_name
         FROM product_batches pb
         JOIN products p ON p.id=pb.product_id
         JOIN brands b ON b.id=p.brand_id
        WHERE ($1::uuid IS NULL OR pb.product_id=$1)
          AND ($2::text IS NULL OR pb.batch_number ILIKE '%'||$2||'%' OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE '%'||$2||'%')
          AND ($3::boolean OR pb.quantity_remaining > 0)
        ORDER BY pb.expiry_date, p.name LIMIT 300`,
      [filters.productId ?? null, filters.search ?? null, filters.includeDepleted],
    );
    response.json({ data: result.rows });
  }),
);

/** Goods-received note: creates the batch and raises on-hand stock together. */
router.post(
  "/batches",
  guard,
  asyncHandler(async (request, response) => {
    const input = z
      .object({
        productId: z.uuid(),
        batchNumber: z.string().min(1).max(80),
        expiryDate: z.iso.date(),
        manufacturedOn: z.iso.date().optional(),
        quantity: z.coerce.number().int().positive().max(1_000_000),
        supplier: z.string().max(200).optional(),
      })
      .parse(request.body);

    if (new Date(input.expiryDate) <= new Date()) {
      throw new ApiError(422, "Cannot receive stock that has already expired", "BATCH_ALREADY_EXPIRED");
    }

    const batch = await transaction(async (client) => {
      const existing = await client.query(`SELECT id FROM product_batches WHERE product_id=$1 AND batch_number=$2`, [
        input.productId,
        input.batchNumber,
      ]);
      if (existing.rowCount) {
        throw new ApiError(409, "That batch number already exists for this product", "DUPLICATE_BATCH");
      }

      const created = await client.query(
        `INSERT INTO product_batches(product_id,batch_number,expiry_date,manufactured_on,quantity_received,quantity_remaining,supplier)
         VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING *`,
        [
          input.productId, input.batchNumber, input.expiryDate, input.manufacturedOn ?? null,
          input.quantity, input.supplier ?? null,
        ],
      );
      await adjustStock(client, {
        productId: input.productId,
        delta: input.quantity,
        reason: "RECEIPT",
        actorUserId: request.auth!.userId,
        referenceType: "batch",
        referenceId: created.rows[0]!.id as string,
        batchId: created.rows[0]!.id as string,
        note: `Batch ${input.batchNumber} · expires ${input.expiryDate}`,
      });
      return created.rows[0];
    });

    response.status(201).json({ data: batch });
  }),
);

/** Writes off expired stock so it can never be picked or sold. */
router.post(
  "/batches/:id/write-off",
  guard,
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);

    const result = await transaction(async (client) => {
      const batch = await client.query<{ id: string; product_id: string; quantity_remaining: number; batch_number: string }>(
        `SELECT id,product_id,quantity_remaining,batch_number FROM product_batches WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const record = batch.rows[0];
      if (!record) throw new ApiError(404, "Batch not found", "NOT_FOUND");
      if (record.quantity_remaining === 0) throw new ApiError(422, "This batch is already depleted", "BATCH_EMPTY");

      await client.query(`UPDATE product_batches SET quantity_remaining=0 WHERE id=$1`, [id]);
      await adjustStock(client, {
        productId: record.product_id,
        delta: -record.quantity_remaining,
        reason: "EXPIRY_WRITE_OFF",
        actorUserId: request.auth!.userId,
        referenceType: "batch",
        referenceId: id,
        batchId: id,
        note: input.reason,
      });
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'BATCH_WRITTEN_OFF','product_batch',$2,$3)`,
        [request.auth!.userId, id, JSON.stringify({ ...input, quantity: record.quantity_remaining })],
      );
      return { id, writtenOff: record.quantity_remaining, batchNumber: record.batch_number };
    });

    response.json({ data: result });
  }),
);

/**
 * Recall: quarantines remaining stock and returns the list of clients who
 * already received units from the batch, which is what a regulator asks for.
 */
router.post(
  "/batches/:id/recall",
  guard,
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);

    const outcome = await transaction(async (client) => {
      const batch = await client.query<{ id: string; product_id: string; quantity_remaining: number }>(
        `SELECT id,product_id,quantity_remaining FROM product_batches WHERE id=$1 AND recalled_at IS NULL FOR UPDATE`,
        [id],
      );
      const record = batch.rows[0];
      if (!record) throw new ApiError(404, "Batch not found or already recalled", "NOT_FOUND");

      await client.query(`UPDATE product_batches SET recalled_at=now(), recall_reason=$2, quantity_remaining=0 WHERE id=$1`, [
        id,
        input.reason,
      ]);
      if (record.quantity_remaining > 0) {
        await adjustStock(client, {
          productId: record.product_id,
          delta: -record.quantity_remaining,
          reason: "RECALL",
          actorUserId: request.auth!.userId,
          referenceType: "batch",
          referenceId: id,
          batchId: id,
          note: input.reason,
        });
      }

      const affected = await client.query(
        `SELECT DISTINCT b.id AS business_id,b.name AS business_name,u.email,u.full_name,
                o.reference AS order_reference,o.id AS order_id,ob.quantity,i.product_name
           FROM order_item_batches ob
           JOIN order_items i ON i.id=ob.order_item_id
           JOIN orders o ON o.id=i.order_id
           JOIN businesses b ON b.id=o.business_id
           JOIN users u ON u.id=o.created_by
          WHERE ob.batch_id=$1
          ORDER BY b.name`,
        [id],
      );
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'BATCH_RECALLED','product_batch',$2,$3)`,
        [request.auth!.userId, id, JSON.stringify({ ...input, affectedOrders: affected.rowCount })],
      );
      return { quarantined: record.quantity_remaining, affected: affected.rows };
    });

    response.json({ data: outcome });
  }),
);

/* ------------------------------ stock movements ---------------------------- */

router.get(
  "/stock-movements",
  guard,
  asyncHandler(async (request, response) => {
    const filters = z
      .object({ productId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) })
      .parse(request.query);

    const result = await query(
      `SELECT m.id,m.product_id,m.reason,m.quantity_delta,m.balance_after,m.reference_type,m.reference_id,
              m.note,m.created_at,p.name AS product_name,p.sku,pb.batch_number,
              (SELECT full_name FROM users WHERE id=m.actor_user_id) AS actor
         FROM stock_movements m
         JOIN products p ON p.id=m.product_id
         LEFT JOIN product_batches pb ON pb.id=m.batch_id
        WHERE ($1::uuid IS NULL OR m.product_id=$1)
        ORDER BY m.created_at DESC LIMIT $2`,
      [filters.productId ?? null, filters.limit],
    );
    response.json({ data: result.rows });
  }),
);

export default router;
