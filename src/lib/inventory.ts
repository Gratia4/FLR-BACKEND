import type { PoolClient } from "pg";
import { ApiError } from "./errors.js";

export type MovementReason = "RECEIPT" | "ORDER" | "CANCELLATION" | "RETURN" | "ADJUSTMENT" | "EXPIRY_WRITE_OFF" | "RECALL";

export type Allocation = { batchId: string; batchNumber: string; expiryDate: string; quantity: number };

/**
 * Adjusts on-hand stock and writes the ledger entry in one place so the
 * movement history can always be reconciled against products.stock_quantity.
 */
export async function adjustStock(
  client: PoolClient,
  input: {
    productId: string;
    delta: number;
    reason: MovementReason;
    actorUserId?: string | null;
    referenceType?: string;
    referenceId?: string;
    batchId?: string | null;
    note?: string;
  },
) {
  const updated = await client.query<{ stock_quantity: number }>(
    `UPDATE products SET stock_quantity = stock_quantity + $1
      WHERE id = $2 AND stock_quantity + $1 >= 0
      RETURNING stock_quantity`,
    [input.delta, input.productId],
  );
  if (!updated.rowCount) {
    const exists = await client.query(`SELECT id FROM products WHERE id=$1`, [input.productId]);
    if (!exists.rowCount) throw new ApiError(404, "Product not found", "NOT_FOUND");
    throw new ApiError(422, "This movement would make stock negative", "INSUFFICIENT_STOCK");
  }

  await client.query(
    `INSERT INTO stock_movements(product_id,batch_id,reason,quantity_delta,balance_after,reference_type,reference_id,actor_user_id,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.productId,
      input.batchId ?? null,
      input.reason,
      input.delta,
      updated.rows[0]!.stock_quantity,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.actorUserId ?? null,
      input.note ?? null,
    ],
  );
  return updated.rows[0]!.stock_quantity;
}

/**
 * First-Expired-First-Out allocation. Expired and recalled batches are never
 * picked. Products with no batch records fall back to plain quantity tracking
 * so the system keeps working for catalogue lines that are not lot-controlled.
 */
export async function allocateFefo(
  client: PoolClient,
  productId: string,
  quantity: number,
  productName: string,
): Promise<Allocation[]> {
  const batches = await client.query<{ id: string; batch_number: string; expiry_date: string; quantity_remaining: number }>(
    `SELECT id,batch_number,expiry_date,quantity_remaining FROM product_batches
      WHERE product_id = $1 AND quantity_remaining > 0 AND recalled_at IS NULL AND expiry_date > CURRENT_DATE
      ORDER BY expiry_date, received_at FOR UPDATE`,
    [productId],
  );
  if (!batches.rowCount) return [];

  const available = batches.rows.reduce((sum, batch) => sum + batch.quantity_remaining, 0);
  if (available < quantity) {
    throw new ApiError(
      422,
      `Only ${available} unit${available === 1 ? "" : "s"} of ${productName} remain in unexpired batches.`,
      "INSUFFICIENT_UNEXPIRED_STOCK",
      { productId, available },
    );
  }

  const allocations: Allocation[] = [];
  let remaining = quantity;
  for (const batch of batches.rows) {
    if (remaining === 0) break;
    const take = Math.min(remaining, batch.quantity_remaining);
    await client.query(`UPDATE product_batches SET quantity_remaining = quantity_remaining - $1 WHERE id = $2`, [take, batch.id]);
    allocations.push({ batchId: batch.id, batchNumber: batch.batch_number, expiryDate: batch.expiry_date, quantity: take });
    remaining -= take;
  }
  return allocations;
}

/** Puts allocated units back on their original batches (cancellation / restocked return). */
export async function releaseAllocations(client: PoolClient, orderItemId: string) {
  const allocations = await client.query<{ batch_id: string; quantity: number }>(
    `SELECT batch_id, quantity FROM order_item_batches WHERE order_item_id = $1`,
    [orderItemId],
  );
  for (const allocation of allocations.rows) {
    await client.query(
      `UPDATE product_batches
          SET quantity_remaining = LEAST(quantity_received, quantity_remaining + $1)
        WHERE id = $2`,
      [allocation.quantity, allocation.batch_id],
    );
  }
  await client.query(`DELETE FROM order_item_batches WHERE order_item_id = $1`, [orderItemId]);
  return allocations.rows;
}
