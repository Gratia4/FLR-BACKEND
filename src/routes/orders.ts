import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { createReference } from "../lib/reference.js";
import { authenticate, requireApprovedClient } from "../middleware/authenticate.js";
import { buildOrderLines } from "../lib/order-builder.js";
import { assertCreditAvailable, creditPosition } from "../lib/credit.js";
import { adjustStock, allocateFefo, releaseAllocations } from "../lib/inventory.js";
import { mails } from "../lib/mailer.js";

const router = Router();
router.use(authenticate, requireApprovedClient);

const checkoutSchema = z.object({
  deliveryAddressId: z.uuid().optional(),
  purchaseOrderReference: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  requestedDeliveryDate: z.iso.date().optional(),
  /** Omit to check out whatever is in the stored cart. */
  items: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().positive().max(100000) })).max(100).optional(),
});

/* --------------------------------- checkout -------------------------------- */

router.post(
  "/",
  asyncHandler(async (request, response) => {
    const input = checkoutSchema.parse(request.body);
    const auth = request.auth!;
    const businessId = auth.businessId!;
    const reference = createReference("ORD");

    const result = await transaction(async (client) => {
      const requested =
        input.items ??
        (
          await client.query<{ product_id: string; quantity: number }>(
            `SELECT product_id, quantity FROM cart_items WHERE business_id = $1`,
            [businessId],
          )
        ).rows.map((row) => ({ productId: row.product_id, quantity: row.quantity }));

      if (!requested.length) throw new ApiError(422, "Your cart is empty", "EMPTY_ORDER");

      // Serialize checkout per business. Without this lock, two simultaneous
      // orders can both observe the same available credit and overspend it.
      await client.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [businessId]);

      const { lines, totals } = await buildOrderLines(client, businessId, requested, { lock: true });

      // Credit is checked against the committed total, after VAT and discounts.
      const position = await creditPosition(businessId, client);
      assertCreditAvailable(position, totals.totalRwf);

      // Validate the delivery address belongs to this business.
      let addressId = input.deliveryAddressId ?? null;
      if (addressId) {
        const address = await client.query(`SELECT id FROM delivery_addresses WHERE id = $1 AND business_id = $2`, [
          addressId,
          businessId,
        ]);
        if (!address.rowCount) throw new ApiError(422, "That delivery address is not on this account", "INVALID_ADDRESS");
      } else {
        const fallback = await client.query<{ id: string }>(
          `SELECT id FROM delivery_addresses WHERE business_id = $1 ORDER BY is_default DESC, created_at LIMIT 1`,
          [businessId],
        );
        addressId = fallback.rows[0]?.id ?? null;
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO orders
           (reference,business_id,created_by,delivery_address_id,status,purchase_order_reference,notes,
            subtotal_rwf,vat_rwf,discount_rwf,total_rwf,expected_delivery_date,submitted_at)
         VALUES($1,$2,$3,$4,'SUBMITTED',$5,$6,$7,$8,$9,$10,$11,now())
         RETURNING id`,
        [
          reference,
          businessId,
          auth.userId,
          addressId,
          input.purchaseOrderReference ?? null,
          input.notes ?? null,
          totals.subtotalRwf,
          totals.vatRwf,
          totals.discountRwf,
          totals.totalRwf,
          input.requestedDeliveryDate ?? null,
        ],
      );
      const orderId = created.rows[0]!.id;

      for (const line of lines) {
        const item = await client.query<{ id: string }>(
          `INSERT INTO order_items
             (order_id,product_id,product_name,sku,quantity,unit_price_rwf,list_price_rwf,line_total_rwf,vat_rate,vat_rwf)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            orderId,
            line.productId,
            line.product.name,
            line.product.sku,
            line.quantity,
            line.unitPriceRwf,
            line.listPriceRwf,
            line.lineTotalRwf,
            line.vatRate,
            line.vatRwf,
          ],
        );

        if (line.product.stock_status === "PRE_ORDER") continue;

        // FEFO: reserve the shortest-dated unexpired batches first.
        const allocations = await allocateFefo(client, line.productId, line.quantity, line.product.name);
        for (const allocation of allocations) {
          await client.query(`INSERT INTO order_item_batches(order_item_id,batch_id,quantity) VALUES($1,$2,$3)`, [
            item.rows[0]!.id,
            allocation.batchId,
            allocation.quantity,
          ]);
        }
        await adjustStock(client, {
          productId: line.productId,
          delta: -line.quantity,
          reason: "ORDER",
          actorUserId: auth.userId,
          referenceType: "order",
          referenceId: orderId,
          batchId: allocations[0]?.batchId ?? null,
          note: allocations.length ? `FEFO: ${allocations.map((a) => a.batchNumber).join(", ")}` : undefined,
        });
      }

      await client.query(`DELETE FROM cart_items WHERE business_id = $1`, [businessId]);
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'ORDER_SUBMITTED','order',$2,$3)`,
        [auth.userId, orderId, JSON.stringify({ reference, total: totals.totalRwf, lines: lines.length })],
      );

      return { orderId, totals, lineCount: lines.length };
    });

    const contact = await query<{ email: string; full_name: string }>(
      `SELECT email, full_name FROM users WHERE id = $1`,
      [auth.userId],
    );
    if (contact.rows[0]) {
      await mails.orderConfirmation(
        contact.rows[0].email,
        contact.rows[0].full_name,
        reference,
        result.totals.totalRwf,
        result.lineCount,
      );
    }

    response.status(201).json({
      id: result.orderId,
      reference,
      status: "SUBMITTED",
      totals: result.totals,
    });
  }),
);

/* ------------------------------- order history ------------------------------ */

router.get(
  "/",
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        status: z.enum(["SUBMITTED", "PROCESSING", "SHIPPED", "DELIVERED", "INVOICED", "CANCELLED"]).optional(),
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const result = await query(
      `SELECT o.id,o.reference,o.status,o.purchase_order_reference,o.subtotal_rwf,o.vat_rwf,o.discount_rwf,
              o.total_rwf,o.tracking_number,o.expected_delivery_date,o.submitted_at,o.delivered_at,o.created_at,
              COUNT(i.id)::int AS item_count,
              COALESCE(SUM(i.quantity),0)::int AS total_quantity,
              inv.reference AS invoice_reference, inv.status AS invoice_status,
              COUNT(*) OVER()::int AS total_count
         FROM orders o
         LEFT JOIN order_items i ON i.order_id = o.id
         LEFT JOIN invoices inv ON inv.order_id = o.id
        WHERE o.business_id = $1
          AND ($2::order_status IS NULL OR o.status = $2)
          AND ($3::text IS NULL OR o.reference ILIKE '%'||$3||'%' OR o.purchase_order_reference ILIKE '%'||$3||'%')
        GROUP BY o.id, inv.reference, inv.status
        ORDER BY o.created_at DESC
        LIMIT $4 OFFSET $5`,
      [request.auth!.businessId, filters.status ?? null, filters.search ?? null, filters.limit, filters.offset],
    );
    response.json({
      data: result.rows,
      total: (result.rows[0] as { total_count?: number })?.total_count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const order = await query(
      `SELECT o.*, u.full_name AS created_by_name,
              CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object(
                'label',a.label,'recipientName',a.recipient_name,'phone',a.phone,
                'streetAddress',a.street_address,'district',a.district,'country',a.country) END AS delivery_address,
              CASE WHEN inv.id IS NULL THEN NULL ELSE json_build_object(
                'id',inv.id,'reference',inv.reference,'status',inv.status,'dueAt',inv.due_at,
                'totalRwf',inv.total_rwf,'amountPaidRwf',inv.amount_paid_rwf) END AS invoice
         FROM orders o
         JOIN users u ON u.id = o.created_by
         LEFT JOIN delivery_addresses a ON a.id = o.delivery_address_id
         LEFT JOIN invoices inv ON inv.order_id = o.id
        WHERE o.id = $1 AND o.business_id = $2`,
      [id, request.auth!.businessId],
    );
    if (!order.rowCount) throw new ApiError(404, "Order not found", "NOT_FOUND");

    const items = await query(
      `SELECT i.id,i.product_id,i.product_name,i.sku,i.quantity,i.unit_price_rwf,i.list_price_rwf,
              i.line_total_rwf,i.vat_rate,i.vat_rwf,p.image_urls,p.size
         FROM order_items i LEFT JOIN products p ON p.id = i.product_id
        WHERE i.order_id = $1 ORDER BY i.product_name`,
      [id],
    );
    response.json({ data: { ...order.rows[0], items: items.rows } });
  }),
);

/* --------------------------- cancel / reorder ------------------------------ */

router.post(
  "/:id/cancel",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
    const auth = request.auth!;

    const updated = await transaction(async (client) => {
      const order = await client.query<{ id: string; reference: string; status: string }>(
        `SELECT id, reference, status FROM orders WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [id, auth.businessId],
      );
      const record = order.rows[0];
      if (!record) throw new ApiError(404, "Order not found", "NOT_FOUND");
      // Once picking starts, cancellation is an operations decision, not a self-service one.
      if (record.status !== "SUBMITTED") {
        throw new ApiError(
          422,
          `This order is already ${record.status.toLowerCase()} and can no longer be cancelled online. Contact your account manager.`,
          "ORDER_NOT_CANCELLABLE",
        );
      }

      await restoreOrderStock(client, id, auth.userId, "CANCELLATION");
      await client.query(
        `UPDATE orders SET status='CANCELLED', cancelled_reason=$2, cancelled_at=now() WHERE id=$1`,
        [id, input.reason],
      );
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'ORDER_CANCELLED','order',$2,$3)`,
        [auth.userId, id, JSON.stringify({ reason: input.reason, by: "client" })],
      );
      return record;
    });

    response.json({ data: { id, reference: updated.reference, status: "CANCELLED" } });
  }),
);

/** Copies a previous order's lines into the cart, skipping anything delisted. */
router.post(
  "/:id/reorder",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const businessId = request.auth!.businessId!;

    const items = await query<{ product_id: string; quantity: number; product_name: string; is_active: boolean }>(
      `SELECT i.product_id, i.quantity, i.product_name, COALESCE(p.is_active,false) AS is_active
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
         LEFT JOIN products p ON p.id = i.product_id
        WHERE o.id = $1 AND o.business_id = $2`,
      [id, businessId],
    );
    if (!items.rowCount) throw new ApiError(404, "Order not found", "NOT_FOUND");

    const available = items.rows.filter((item) => item.is_active);
    const skipped = items.rows.filter((item) => !item.is_active).map((item) => item.product_name);

    for (const item of available) {
      await query(
        `INSERT INTO cart_items(business_id,product_id,quantity,added_by) VALUES($1,$2,$3,$4)
         ON CONFLICT (business_id,product_id) DO UPDATE SET quantity = cart_items.quantity + excluded.quantity`,
        [businessId, item.product_id, item.quantity, request.auth!.userId],
      );
    }
    response.json({ data: { added: available.length, skipped } });
  }),
);

/* --------------------------------- returns --------------------------------- */

router.post(
  "/:id/returns",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z
      .object({
        reason: z.enum(["DAMAGED", "EXPIRED", "WRONG_ITEM", "SHORT_DATED", "RECALL", "OTHER"]),
        note: z.string().max(1000).optional(),
        items: z.array(z.object({ orderItemId: z.uuid(), quantity: z.number().int().positive() })).min(1).max(100),
      })
      .parse(request.body);
    const auth = request.auth!;
    const reference = createReference("RET");

    const returnId = await transaction(async (client) => {
      const order = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM orders WHERE id = $1 AND business_id = $2`,
        [id, auth.businessId],
      );
      if (!order.rowCount) throw new ApiError(404, "Order not found", "NOT_FOUND");
      if (!["DELIVERED", "INVOICED"].includes(order.rows[0]!.status)) {
        throw new ApiError(422, "Only delivered orders can be returned", "ORDER_NOT_RETURNABLE");
      }

      for (const item of input.items) {
        const line = await client.query<{ quantity: number; returned: string }>(
          `SELECT i.quantity,
                  COALESCE((SELECT SUM(ri.quantity) FROM return_items ri
                             JOIN returns r ON r.id = ri.return_id
                            WHERE ri.order_item_id = i.id AND r.status <> 'REJECTED'),0) AS returned
             FROM order_items i WHERE i.id = $1 AND i.order_id = $2`,
          [item.orderItemId, id],
        );
        const record = line.rows[0];
        if (!record) throw new ApiError(422, "That line is not on this order", "INVALID_RETURN_ITEM");
        const remaining = record.quantity - Number(record.returned);
        if (item.quantity > remaining) {
          throw new ApiError(422, `Only ${remaining} unit(s) of that line remain returnable`, "RETURN_QUANTITY_EXCEEDED");
        }
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO returns(reference,order_id,business_id,reason,note,requested_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [reference, id, auth.businessId, input.reason, input.note ?? null, auth.userId],
      );
      for (const item of input.items) {
        await client.query(`INSERT INTO return_items(return_id,order_item_id,quantity) VALUES($1,$2,$3)`, [
          created.rows[0]!.id,
          item.orderItemId,
          item.quantity,
        ]);
      }
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'RETURN_REQUESTED','return',$2,$3)`,
        [auth.userId, created.rows[0]!.id, JSON.stringify({ reference, reason: input.reason })],
      );
      return created.rows[0]!.id;
    });

    response.status(201).json({ id: returnId, reference, status: "REQUESTED" });
  }),
);

router.get(
  "/returns/all",
  asyncHandler(async (request, response) => {
    const result = await query(
      `SELECT r.id,r.reference,r.status,r.reason,r.note,r.credit_amount_rwf,r.credit_note_reference,r.created_at,
              o.reference AS order_reference,
              COALESCE(json_agg(json_build_object('productName',i.product_name,'sku',i.sku,'quantity',ri.quantity))
                       FILTER (WHERE ri.id IS NOT NULL),'[]') AS items
         FROM returns r
         JOIN orders o ON o.id = r.order_id
         LEFT JOIN return_items ri ON ri.return_id = r.id
         LEFT JOIN order_items i ON i.id = ri.order_item_id
        WHERE r.business_id = $1
        GROUP BY r.id, o.reference
        ORDER BY r.created_at DESC LIMIT 100`,
      [request.auth!.businessId],
    );
    response.json({ data: result.rows });
  }),
);

/* --------------------------------- helpers --------------------------------- */

export async function restoreOrderStock(
  client: import("pg").PoolClient,
  orderId: string,
  actorUserId: string,
  reason: "CANCELLATION" | "RETURN",
) {
  const items = await client.query<{ id: string; product_id: string; quantity: number; stock_status: string }>(
    `SELECT i.id, i.product_id, i.quantity, p.stock_status
       FROM order_items i JOIN products p ON p.id = i.product_id
      WHERE i.order_id = $1`,
    [orderId],
  );
  for (const item of items.rows) {
    if (item.stock_status === "PRE_ORDER") continue;
    await releaseAllocations(client, item.id);
    await adjustStock(client, {
      productId: item.product_id,
      delta: item.quantity,
      reason,
      actorUserId,
      referenceType: "order",
      referenceId: orderId,
    });
  }
}

export default router;
