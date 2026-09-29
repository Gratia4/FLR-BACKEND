import { Router } from "express";
import { z } from "zod";
import { pool, query, transaction } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { authenticate, requireApprovedClient } from "../middleware/authenticate.js";
import { buildOrderLines } from "../lib/order-builder.js";
import { creditPosition } from "../lib/credit.js";

const router = Router();
router.use(authenticate, requireApprovedClient);

type CartProduct = { id: string; name: string; minimum_order_quantity: number; case_size: number };

function assertValidQuantity(product: CartProduct, quantity: number) {
  if (quantity < product.minimum_order_quantity) {
    throw new ApiError(422, `${product.name} has a minimum order quantity of ${product.minimum_order_quantity}`, "MOQ_NOT_MET");
  }
  if (product.case_size > 1 && quantity % product.case_size !== 0) {
    throw new ApiError(422, `${product.name} is sold in cases of ${product.case_size}`, "CASE_SIZE_MISMATCH");
  }
}

/**
 * The cart lives on the business, not the browser, so a buyer can start an
 * order on one device and complete it on another — and so a colleague at the
 * same pharmacy sees the same basket.
 */
async function readCart(businessId: string) {
  const rows = await query<{ product_id: string; quantity: number }>(
    `SELECT product_id, quantity FROM cart_items WHERE business_id = $1 ORDER BY created_at`,
    [businessId],
  );
  if (!rows.rowCount) {
    return { items: [], totals: { subtotalRwf: 0, vatRwf: 0, discountRwf: 0, deliveryFeeRwf: 0, totalRwf: 0 }, issues: [] };
  }

  const client = await pool.connect();
  try {
    // Price the basket without stock enforcement so the client can see what is
    // wrong and fix it, rather than getting a bare error.
    const { lines, totals, tier } = await buildOrderLines(
      client,
      businessId,
      rows.rows.map((row) => ({ productId: row.product_id, quantity: row.quantity })),
      { enforceStock: false },
    );

    const issues = lines
      .filter((line) => line.product.stock_status !== "PRE_ORDER" && line.quantity > line.product.stock_quantity)
      .map((line) => ({
        productId: line.productId,
        message: `Only ${line.product.stock_quantity} in stock`,
        available: line.product.stock_quantity,
      }));

    return {
      items: lines.map((line) => ({
        productId: line.productId,
        sku: line.product.sku,
        name: line.product.name,
        brandName: line.product.brand_name,
        size: line.product.size,
        imageUrls: line.product.image_urls,
        quantity: line.quantity,
        caseSize: line.product.case_size,
        minimumOrderQuantity: line.product.minimum_order_quantity,
        stockStatus: line.product.stock_status,
        stockQuantity: line.product.stock_quantity,
        coldChain: line.product.cold_chain,
        requiresPrescription: line.product.requires_prescription,
        listPriceRwf: line.listPriceRwf,
        unitPriceRwf: line.unitPriceRwf,
        lineTotalRwf: line.lineTotalRwf,
        vatRate: line.vatRate,
        vatRwf: line.vatRwf,
      })),
      totals,
      tier,
      issues,
    };
  } finally {
    client.release();
  }
}

router.get(
  "/",
  asyncHandler(async (request, response) => {
    const businessId = request.auth!.businessId!;
    const [cart, credit] = await Promise.all([readCart(businessId), creditPosition(businessId)]);
    response.json({ data: { ...cart, credit } });
  }),
);

router.put(
  "/items",
  asyncHandler(async (request, response) => {
    const input = z
      .object({ productId: z.uuid(), quantity: z.number().int().min(0).max(100000) })
      .parse(request.body);
    const businessId = request.auth!.businessId!;

    if (input.quantity === 0) {
      await query(`DELETE FROM cart_items WHERE business_id = $1 AND product_id = $2`, [businessId, input.productId]);
    } else {
      const product = await query<CartProduct>(
        `SELECT id,name,minimum_order_quantity,case_size FROM products WHERE id = $1 AND is_active`,
        [input.productId],
      );
      if (!product.rowCount) throw new ApiError(404, "Product not found", "NOT_FOUND");
      assertValidQuantity(product.rows[0]!, input.quantity);
      await query(
        `INSERT INTO cart_items(business_id,product_id,quantity,added_by) VALUES($1,$2,$3,$4)
         ON CONFLICT (business_id,product_id) DO UPDATE SET quantity = excluded.quantity, added_by = excluded.added_by`,
        [businessId, input.productId, input.quantity, request.auth!.userId],
      );
    }
    response.json({ data: await readCart(businessId) });
  }),
);

/** Merges a guest/offline basket into the stored cart after sign-in. */
router.post(
  "/merge",
  asyncHandler(async (request, response) => {
    const input = z
      .object({ items: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().positive().max(100000) })).max(100) })
      .parse(request.body);
    const businessId = request.auth!.businessId!;

    await transaction(async (client) => {
      const ids = [...new Set(input.items.map((item) => item.productId))];
      const products = await client.query<CartProduct>(
        `SELECT id,name,minimum_order_quantity,case_size FROM products WHERE id = ANY($1::uuid[]) AND is_active`,
        [ids],
      );
      if (products.rowCount !== ids.length) throw new ApiError(422, "One or more products are no longer available", "PRODUCT_UNAVAILABLE");
      for (const item of input.items) {
        const product = products.rows.find((candidate) => candidate.id === item.productId)!;
        assertValidQuantity(product, item.quantity);
        await client.query(
          `INSERT INTO cart_items(business_id,product_id,quantity,added_by) VALUES($1,$2,$3,$4)
           ON CONFLICT (business_id,product_id) DO UPDATE SET quantity = GREATEST(cart_items.quantity, excluded.quantity)`,
          [businessId, item.productId, item.quantity, request.auth!.userId],
        );
      }
    });
    response.json({ data: await readCart(businessId) });
  }),
);

router.delete(
  "/",
  asyncHandler(async (request, response) => {
    await query(`DELETE FROM cart_items WHERE business_id = $1`, [request.auth!.businessId]);
    response.json({ data: await readCart(request.auth!.businessId!) });
  }),
);

export default router;
export { readCart };
