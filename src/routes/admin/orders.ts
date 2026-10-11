import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { ApiError } from "../../lib/errors.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { restoreOrderStock } from "../orders.js";
import { mails } from "../../lib/mailer.js";
import { createReference } from "../../lib/reference.js";
import { config } from "../../config.js";
import { adjustStock } from "../../lib/inventory.js";

const router = Router();
router.use(requirePermission("fulfilment"));

/** Legal forward transitions. Anything else is rejected rather than silently applied. */
const TRANSITIONS: Record<string, string[]> = {
  SUBMITTED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [], // invoicing uses POST /:id/invoice so the invoice record cannot be bypassed
  INVOICED: [],
  CANCELLED: [],
  DRAFT: ["SUBMITTED", "CANCELLED"],
};

router.get(
  "/",
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        status: z.enum(["DRAFT", "SUBMITTED", "PROCESSING", "SHIPPED", "DELIVERED", "INVOICED", "CANCELLED"]).optional(),
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(250).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const result = await query(
      `SELECT o.id,o.reference,o.status,o.purchase_order_reference,o.subtotal_rwf,o.vat_rwf,o.discount_rwf,o.total_rwf,
              o.tracking_number,o.expected_delivery_date,o.submitted_at,o.delivered_at,o.created_at,
              b.id AS business_id,b.name AS business_name,b.district,
              u.full_name AS created_by_name,
              COUNT(i.id)::int AS item_count,
              COALESCE(SUM(i.quantity),0)::int AS total_quantity,
              BOOL_OR(p.cold_chain) AS has_cold_chain,
              inv.reference AS invoice_reference,
              COUNT(*) OVER()::int AS total_count
         FROM orders o
         JOIN businesses b ON b.id=o.business_id
         JOIN users u ON u.id=o.created_by
         LEFT JOIN order_items i ON i.order_id=o.id
         LEFT JOIN products p ON p.id=i.product_id
         LEFT JOIN invoices inv ON inv.order_id=o.id
        WHERE ($1::order_status IS NULL OR o.status=$1)
          AND ($2::text IS NULL OR o.reference ILIKE '%'||$2||'%' OR b.name ILIKE '%'||$2||'%'
               OR o.purchase_order_reference ILIKE '%'||$2||'%')
        GROUP BY o.id,b.id,u.id,inv.reference
        ORDER BY o.created_at DESC
        LIMIT $3 OFFSET $4`,
      [filters.status ?? null, filters.search ?? null, filters.limit, filters.offset],
    );
    response.json({
      data: result.rows,
      total: (result.rows[0] as { total_count?: number })?.total_count ?? 0,
    });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const order = await query(
      `SELECT o.*, b.name AS business_name, b.tin, b.vat_registration_number, b.payment_terms_days,
              u.full_name AS created_by_name, u.email AS created_by_email, u.phone AS created_by_phone,
              CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object(
                'label',a.label,'recipientName',a.recipient_name,'phone',a.phone,
                'streetAddress',a.street_address,'district',a.district,'country',a.country) END AS delivery_address,
              CASE WHEN inv.id IS NULL THEN NULL ELSE json_build_object(
                'id',inv.id,'reference',inv.reference,'status',inv.status,'dueAt',inv.due_at,
                'totalRwf',inv.total_rwf,'amountPaidRwf',inv.amount_paid_rwf) END AS invoice
         FROM orders o
         JOIN businesses b ON b.id=o.business_id
         JOIN users u ON u.id=o.created_by
         LEFT JOIN delivery_addresses a ON a.id=o.delivery_address_id
         LEFT JOIN invoices inv ON inv.order_id=o.id
        WHERE o.id=$1`,
      [id],
    );
    if (!order.rowCount) throw new ApiError(404, "Order not found", "NOT_FOUND");

    // Picking list, including which batch each line was allocated from.
    const items = await query(
      `SELECT i.id,i.product_id,i.product_name,i.sku,i.quantity,i.unit_price_rwf,i.list_price_rwf,
              i.line_total_rwf,i.vat_rate,i.vat_rwf,p.cold_chain,p.requires_prescription,p.size,p.image_urls,
              COALESCE(json_agg(json_build_object('batchNumber',pb.batch_number,'expiryDate',pb.expiry_date,'quantity',ob.quantity))
                       FILTER (WHERE ob.id IS NOT NULL),'[]') AS batches
         FROM order_items i
         LEFT JOIN products p ON p.id=i.product_id
         LEFT JOIN order_item_batches ob ON ob.order_item_id=i.id
         LEFT JOIN product_batches pb ON pb.id=ob.batch_id
        WHERE i.order_id=$1
        GROUP BY i.id,p.cold_chain,p.requires_prescription,p.size,p.image_urls
        ORDER BY i.product_name`,
      [id],
    );
    const history = await query(
      `SELECT action, metadata, created_at, (SELECT full_name FROM users WHERE id=actor_user_id) AS actor
         FROM audit_logs WHERE entity_type='order' AND entity_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [id],
    );

    response.json({ data: { ...order.rows[0], items: items.rows, history: history.rows } });
  }),
);

router.patch(
  "/:id/status",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z
      .object({
        status: z.enum(["PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]),
        trackingNumber: z.string().max(120).optional(),
        expectedDeliveryDate: z.iso.date().optional(),
        reason: z.string().max(500).optional(),
      })
      .parse(request.body);

    if (input.status === "SHIPPED" && !input.trackingNumber?.trim()) {
      throw new ApiError(422, "A tracking or dispatch reference is required when shipping", "TRACKING_REQUIRED");
    }
    if (input.status === "CANCELLED" && !input.reason?.trim()) {
      throw new ApiError(422, "A cancellation reason is required", "REASON_REQUIRED");
    }

    const result = await transaction(async (client) => {
      const existing = await client.query<{ status: string; reference: string; business_id: string }>(
        `SELECT status, reference, business_id FROM orders WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const order = existing.rows[0];
      if (!order) throw new ApiError(404, "Order not found", "NOT_FOUND");

      const allowed = TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(input.status)) {
        throw new ApiError(
          422,
          `An order that is ${order.status.toLowerCase()} cannot move to ${input.status.toLowerCase()}`,
          "INVALID_TRANSITION",
          { from: order.status, allowed },
        );
      }

      // Cancelling returns every allocated unit to its batch and to on-hand stock.
      if (input.status === "CANCELLED") await restoreOrderStock(client, id, request.auth!.userId, "CANCELLATION");

      const updated = await client.query(
        `UPDATE orders
            SET status=$1::order_status,
                tracking_number=COALESCE($2,tracking_number),
                expected_delivery_date=COALESCE($3::date,expected_delivery_date),
                delivered_at = CASE WHEN $1::order_status='DELIVERED' THEN now() ELSE delivered_at END,
                cancelled_at = CASE WHEN $1::order_status='CANCELLED' THEN now() ELSE cancelled_at END,
                cancelled_reason = CASE WHEN $1::order_status='CANCELLED' THEN $4 ELSE cancelled_reason END
          WHERE id=$5
          RETURNING id,reference,status,tracking_number,expected_delivery_date,updated_at`,
        [input.status, input.trackingNumber ?? null, input.expectedDeliveryDate ?? null, input.reason ?? null, id],
      );

      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'ORDER_STATUS_CHANGED','order',$2,$3)`,
        [request.auth!.userId, id, JSON.stringify({ from: order.status, ...input })],
      );
      return updated.rows[0] as { id: string; reference: string; status: string; tracking_number: string | null };
    });

    const contact = await query<{ email: string }>(
      `SELECT u.email FROM orders o JOIN users u ON u.id=o.created_by WHERE o.id=$1`,
      [id],
    );
    if (contact.rows[0]) {
      await mails.orderStatus(contact.rows[0].email, result.reference, result.status, result.tracking_number);
    }

    response.json({ data: result });
  }),
);

/** Issues the invoice for a delivered order and moves it to INVOICED. */
router.post(
  "/:id/invoice",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z.object({ dueInDays: z.coerce.number().int().min(0).max(365).optional() }).parse(request.body ?? {});
    const reference = createReference("INV");

    const invoice = await transaction(async (client) => {
      const order = await client.query<{
        id: string; reference: string; status: string; business_id: string;
        subtotal_rwf: string; vat_rwf: string; total_rwf: string; payment_terms_days: number;
      }>(
        `SELECT o.id,o.reference,o.status,o.business_id,o.subtotal_rwf,o.vat_rwf,o.total_rwf,b.payment_terms_days
           FROM orders o JOIN businesses b ON b.id=o.business_id WHERE o.id=$1 FOR UPDATE OF o`,
        [id],
      );
      const record = order.rows[0];
      if (!record) throw new ApiError(404, "Order not found", "NOT_FOUND");
      if (!["DELIVERED", "SHIPPED"].includes(record.status)) {
        throw new ApiError(422, "Only shipped or delivered orders can be invoiced", "ORDER_NOT_INVOICEABLE");
      }

      const existing = await client.query(`SELECT id FROM invoices WHERE order_id=$1`, [id]);
      if (existing.rowCount) throw new ApiError(409, "This order has already been invoiced", "ALREADY_INVOICED");

      const dueInDays = input.dueInDays ?? record.payment_terms_days ?? config.DEFAULT_PAYMENT_TERMS_DAYS;
      const created = await client.query(
        `INSERT INTO invoices(reference,order_id,business_id,due_at,subtotal_rwf,vat_rwf,total_rwf,issued_by)
         VALUES($1,$2,$3, now() + ($4 || ' days')::interval, $5,$6,$7,$8)
         RETURNING id,reference,status,issued_at,due_at,subtotal_rwf,vat_rwf,total_rwf`,
        [
          reference,
          id,
          record.business_id,
          String(dueInDays),
          record.subtotal_rwf,
          record.vat_rwf,
          record.total_rwf,
          request.auth!.userId,
        ],
      );
      await client.query(`UPDATE orders SET status='INVOICED' WHERE id=$1`, [id]);
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'INVOICE_ISSUED','invoice',$2,$3)`,
        [request.auth!.userId, created.rows[0]!.id as string, JSON.stringify({ reference, orderReference: record.reference })],
      );
      return created.rows[0] as { reference: string; total_rwf: string; due_at: Date };
    });

    const contact = await query<{ email: string }>(
      `SELECT u.email FROM orders o JOIN users u ON u.id=o.created_by WHERE o.id=$1`,
      [id],
    );
    if (contact.rows[0]) {
      await mails.invoiceIssued(
        contact.rows[0].email,
        invoice.reference,
        invoice.total_rwf,
        new Date(invoice.due_at).toISOString().slice(0, 10),
      );
    }

    response.status(201).json({ data: invoice });
  }),
);

/* --------------------------------- returns -------------------------------- */

router.get(
  "/returns/all",
  asyncHandler(async (request, response) => {
    const status = z
      .enum(["REQUESTED", "APPROVED", "RECEIVED", "CREDITED", "REJECTED"])
      .optional()
      .parse(request.query.status);
    const result = await query(
      `SELECT r.id,r.reference,r.status,r.reason,r.note,r.credit_amount_rwf,r.credit_note_reference,r.created_at,
              o.reference AS order_reference, b.name AS business_name, b.id AS business_id,
              COALESCE(json_agg(json_build_object('orderItemId',ri.order_item_id,'productName',i.product_name,
                                                  'sku',i.sku,'quantity',ri.quantity,'unitPriceRwf',i.unit_price_rwf,
                                                  'restock',ri.restock))
                       FILTER (WHERE ri.id IS NOT NULL),'[]') AS items
         FROM returns r
         JOIN orders o ON o.id=r.order_id
         JOIN businesses b ON b.id=r.business_id
         LEFT JOIN return_items ri ON ri.return_id=r.id
         LEFT JOIN order_items i ON i.id=ri.order_item_id
        WHERE ($1::return_status IS NULL OR r.status=$1)
        GROUP BY r.id,o.reference,b.name,b.id
        ORDER BY (r.status='REQUESTED') DESC, r.created_at DESC LIMIT 200`,
      [status ?? null],
    );
    response.json({ data: result.rows });
  }),
);

router.patch(
  "/returns/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z
      .object({
        status: z.enum(["APPROVED", "RECEIVED", "CREDITED", "REJECTED"]),
        creditAmountRwf: z.coerce.number().min(0).max(1_000_000_000).optional(),
        restock: z.boolean().default(false),
        note: z.string().max(500).optional(),
      })
      .parse(request.body);

    const result = await transaction(async (client) => {
      const existing = await client.query<{ status: string; order_id: string; business_id: string; reference: string }>(
        `SELECT status, order_id, business_id, reference FROM returns WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const record = existing.rows[0];
      if (!record) throw new ApiError(404, "Return not found", "NOT_FOUND");
      if (["CREDITED", "REJECTED"].includes(record.status)) {
        throw new ApiError(422, "This return has already been closed", "RETURN_CLOSED");
      }

      const transitions: Record<string, string[]> = {
        REQUESTED: ["APPROVED", "REJECTED"],
        APPROVED: ["RECEIVED", "REJECTED"],
        RECEIVED: ["CREDITED"],
      };
      if (!(transitions[record.status] ?? []).includes(input.status)) {
        throw new ApiError(
          422,
          `A ${record.status.toLowerCase()} return cannot move to ${input.status.toLowerCase()}`,
          "INVALID_RETURN_TRANSITION",
        );
      }
      if (input.status === "CREDITED" && !(input.creditAmountRwf && input.creditAmountRwf > 0)) {
        throw new ApiError(422, "Enter the credit amount before closing this return", "CREDIT_AMOUNT_REQUIRED");
      }

      // Put returned units back on their original traceable batches. A batch
      // that has expired or been recalled can never silently become sellable.
      if (input.status === "RECEIVED" && input.restock) {
        const items = await client.query<{ order_item_id: string; quantity: number; product_id: string }>(
          `SELECT ri.order_item_id, ri.quantity, i.product_id
             FROM return_items ri JOIN order_items i ON i.id=ri.order_item_id
            WHERE ri.return_id=$1 AND NOT ri.restock`,
          [id],
        );
        for (const item of items.rows) {
          const batches = await client.query<{
            batch_id: string; quantity: number; quantity_received: number; quantity_remaining: number;
            expiry_date: string; recalled_at: Date | null;
          }>(
            `SELECT ob.batch_id,ob.quantity,pb.quantity_received,pb.quantity_remaining,pb.expiry_date,pb.recalled_at
               FROM order_item_batches ob JOIN product_batches pb ON pb.id=ob.batch_id
              WHERE ob.order_item_id=$1 ORDER BY pb.expiry_date FOR UPDATE OF pb`,
            [item.order_item_id],
          );
          let remaining = item.quantity;
          for (const batch of batches.rows) {
            if (remaining === 0) break;
            if (batch.recalled_at || new Date(batch.expiry_date) <= new Date()) {
              throw new ApiError(422, "Returned stock belongs to an expired or recalled batch and must be quarantined", "RETURN_BATCH_NOT_RESELLABLE");
            }
            const capacity = Math.max(0, batch.quantity_received - batch.quantity_remaining);
            const putBack = Math.min(remaining, batch.quantity, capacity);
            if (putBack > 0) {
              await client.query(`UPDATE product_batches SET quantity_remaining=quantity_remaining+$1 WHERE id=$2`, [putBack, batch.batch_id]);
              remaining -= putBack;
            }
          }
          if (batches.rowCount && remaining > 0) {
            throw new ApiError(422, "The original batch cannot accept all returned units", "RETURN_BATCH_CAPACITY_EXCEEDED");
          }
          await adjustStock(client, {
            productId: item.product_id,
            delta: item.quantity,
            reason: "RETURN",
            actorUserId: request.auth!.userId,
            referenceType: "return",
            referenceId: id,
            note: input.note ?? undefined,
          });
          await client.query(`UPDATE return_items SET restock=true WHERE return_id=$1 AND order_item_id=$2`, [id, item.order_item_id]);
        }
      }

      const creditNoteReference = input.status === "CREDITED" ? createReference("CRN") : null;
      const updated = await client.query(
        `UPDATE returns
            SET status=$1,
                credit_amount_rwf = COALESCE($2, credit_amount_rwf),
                credit_note_reference = COALESCE($3, credit_note_reference),
                note = COALESCE($4, note),
                resolved_by=$5,
                resolved_at = CASE WHEN $1 IN ('CREDITED','REJECTED') THEN now() ELSE resolved_at END
          WHERE id=$6 RETURNING *`,
        [input.status, input.creditAmountRwf ?? null, creditNoteReference, input.note ?? null, request.auth!.userId, id],
      );

      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'RETURN_UPDATED','return',$2,$3)`,
        [request.auth!.userId, id, JSON.stringify(input)],
      );
      return updated.rows[0];
    });

    response.json({ data: result });
  }),
);

export default router;
