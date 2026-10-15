import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { ApiError } from "../../lib/errors.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { createReference } from "../../lib/reference.js";
import { mails } from "../../lib/mailer.js";

const router = Router();
// This router is mounted without a path prefix (see ./index.ts), so a
// router-wide guard would also block unrelated admin routes for staff without
// "finance" access. The guard is therefore applied to each route below.
const guard = requirePermission("finance");

/* --------------------------------- invoices -------------------------------- */

router.get(
  "/invoices",
  guard,
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        status: z.enum(["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED", "CREDITED"]).optional(),
        overdueOnly: z.coerce.boolean().default(false),
        search: z.string().max(100).optional(),
      })
      .parse(request.query);

    const result = await query(
      `SELECT i.id,i.reference,i.status,i.issued_at,i.due_at,i.subtotal_rwf,i.vat_rwf,i.total_rwf,
              i.amount_paid_rwf,(i.total_rwf - i.amount_paid_rwf) AS balance_rwf,i.ebm_receipt_number,
              (i.status IN ('ISSUED','PARTIALLY_PAID') AND i.due_at < now()) AS is_overdue,
              GREATEST((CURRENT_DATE - i.due_at::date),0)::int AS days_overdue,
              o.reference AS order_reference,o.id AS order_id,
              b.id AS business_id,b.name AS business_name,b.tin
         FROM invoices i
         JOIN orders o ON o.id=i.order_id
         JOIN businesses b ON b.id=i.business_id
        WHERE ($1::invoice_status IS NULL OR i.status=$1)
          AND ($2::boolean = false OR (i.status IN ('ISSUED','PARTIALLY_PAID') AND i.due_at < now()))
          AND ($3::text IS NULL OR i.reference ILIKE '%'||$3||'%' OR b.name ILIKE '%'||$3||'%' OR o.reference ILIKE '%'||$3||'%')
        ORDER BY i.issued_at DESC LIMIT 300`,
      [filters.status ?? null, filters.overdueOnly, filters.search ?? null],
    );
    response.json({ data: result.rows });
  }),
);

router.get(
  "/invoices/:id",
  guard,
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const invoice = await query(
      `SELECT i.*, o.reference AS order_reference, o.delivery_address_id,
              b.name AS business_name,b.tin,b.vat_registration_number,b.street_address,b.district,b.country,
              (SELECT full_name FROM users WHERE id=i.issued_by) AS issued_by_name
         FROM invoices i JOIN orders o ON o.id=i.order_id JOIN businesses b ON b.id=i.business_id
        WHERE i.id=$1`,
      [id],
    );
    if (!invoice.rowCount) throw new ApiError(404, "Invoice not found", "NOT_FOUND");

    const [items, payments] = await Promise.all([
      query(
        `SELECT i.product_name,i.sku,i.quantity,i.unit_price_rwf,i.line_total_rwf,i.vat_rate,i.vat_rwf
           FROM order_items i JOIN invoices inv ON inv.order_id=i.order_id WHERE inv.id=$1 ORDER BY i.product_name`,
        [id],
      ),
      query(
        `SELECT id,reference,method,status,amount_rwf,external_reference,received_at,created_at
           FROM payments WHERE invoice_id=$1 ORDER BY created_at DESC`,
        [id],
      ),
    ]);
    response.json({ data: { ...invoice.rows[0], items: items.rows, payments: payments.rows } });
  }),
);

/** Records the RRA EBM receipt returned by the billing machine for this invoice. */
router.patch(
  "/invoices/:id/ebm",
  guard,
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z
      .object({
        receiptNumber: z.string().min(1).max(120),
        internalData: z.string().max(200).optional(),
        signature: z.string().max(200).optional(),
      })
      .parse(request.body);

    const result = await query(
      `UPDATE invoices SET ebm_receipt_number=$2, ebm_internal_data=$3, ebm_signature=$4, ebm_submitted_at=now()
        WHERE id=$1 RETURNING id,reference,ebm_receipt_number,ebm_submitted_at`,
      [id, input.receiptNumber, input.internalData ?? null, input.signature ?? null],
    );
    if (!result.rowCount) throw new ApiError(404, "Invoice not found", "NOT_FOUND");

    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'EBM_RECEIPT_RECORDED','invoice',$2,$3)`,
      [request.auth!.userId, id, JSON.stringify({ receiptNumber: input.receiptNumber })],
    );
    response.json({ data: result.rows[0] });
  }),
);

/* --------------------------------- payments -------------------------------- */

router.get(
  "/payments",
  guard,
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        status: z.enum(["PENDING", "CONFIRMED", "FAILED", "REVERSED"]).optional(),
        search: z.string().max(100).optional(),
      })
      .parse(request.query);

    const result = await query(
      `SELECT p.id,p.reference,p.method,p.status,p.amount_rwf,p.external_reference,p.payer_note,
              p.received_at,p.created_at,
              b.id AS business_id,b.name AS business_name,
              i.reference AS invoice_reference,i.id AS invoice_id,
              (SELECT full_name FROM users WHERE id=p.recorded_by) AS recorded_by_name
         FROM payments p
         JOIN businesses b ON b.id=p.business_id
         LEFT JOIN invoices i ON i.id=p.invoice_id
        WHERE ($1::payment_status IS NULL OR p.status=$1)
          AND ($2::text IS NULL OR p.reference ILIKE '%'||$2||'%' OR b.name ILIKE '%'||$2||'%'
               OR p.external_reference ILIKE '%'||$2||'%')
        ORDER BY p.created_at DESC LIMIT 300`,
      [filters.status ?? null, filters.search ?? null],
    );
    response.json({ data: result.rows });
  }),
);

/**
 * Records a payment and, when confirmed, applies it to the invoice balance.
 * Invoice status is derived from the balance so it cannot drift out of step.
 */
router.post(
  "/payments",
  guard,
  asyncHandler(async (request, response) => {
    const input = z
      .object({
        businessId: z.uuid(),
        invoiceId: z.uuid().optional(),
        method: z.enum(["MTN_MOMO", "AIRTEL_MONEY", "BANK_TRANSFER", "CASH", "CHEQUE", "CREDIT_NOTE"]),
        amountRwf: z.coerce.number().positive().max(1_000_000_000),
        externalReference: z.string().max(150).optional(),
        payerNote: z.string().max(500).optional(),
        confirmed: z.boolean().default(true),
      })
      .parse(request.body);

    const reference = createReference("PAY");

    const payment = await transaction(async (client) => {
      if (input.invoiceId) {
        const invoice = await client.query<{ id: string; total_rwf: string; amount_paid_rwf: string; status: string }>(
          `SELECT id,total_rwf,amount_paid_rwf,status FROM invoices WHERE id=$1 AND business_id=$2 FOR UPDATE`,
          [input.invoiceId, input.businessId],
        );
        const record = invoice.rows[0];
        if (!record) throw new ApiError(404, "Invoice not found for that client", "NOT_FOUND");

        const balance = Number(record.total_rwf) - Number(record.amount_paid_rwf);
        if (input.confirmed && input.amountRwf > balance + 0.01) {
          throw new ApiError(
            422,
            `That payment exceeds the outstanding balance of RWF ${Math.round(balance).toLocaleString("en-RW")}`,
            "OVERPAYMENT",
            { balanceRwf: balance },
          );
        }

        if (input.confirmed) {
          const paid = Number(record.amount_paid_rwf) + input.amountRwf;
          await client.query(
            `UPDATE invoices
                SET amount_paid_rwf=$2,
                    status = CASE WHEN $2 >= total_rwf - 0.01 THEN 'PAID'::invoice_status ELSE 'PARTIALLY_PAID'::invoice_status END
              WHERE id=$1`,
            [input.invoiceId, paid],
          );
        }
      }

      const created = await client.query(
        `INSERT INTO payments(reference,invoice_id,business_id,method,status,amount_rwf,external_reference,payer_note,received_at,recorded_by)
         VALUES($1,$2,$3,$4,$5::payment_status,$6,$7,$8, CASE WHEN $5::payment_status='CONFIRMED' THEN now() ELSE NULL END, $9)
         RETURNING *`,
        [
          reference, input.invoiceId ?? null, input.businessId, input.method,
          input.confirmed ? "CONFIRMED" : "PENDING", input.amountRwf,
          input.externalReference ?? null, input.payerNote ?? null, request.auth!.userId,
        ],
      );
      await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'PAYMENT_RECORDED','payment',$2,$3)`,
        [request.auth!.userId, created.rows[0]!.id as string, JSON.stringify({ reference, amount: input.amountRwf })],
      );
      return created.rows[0] as { reference: string; amount_rwf: string };
    });

    if (input.confirmed) {
      const contact = await query<{ email: string; invoice_reference: string | null }>(
        `SELECT u.email, (SELECT reference FROM invoices WHERE id=$2) AS invoice_reference
           FROM users u WHERE u.business_id=$1 AND u.role='CLIENT' LIMIT 1`,
        [input.businessId, input.invoiceId ?? null],
      );
      if (contact.rows[0]) {
        await mails.paymentReceived(
          contact.rows[0].email,
          payment.reference,
          payment.amount_rwf,
          contact.rows[0].invoice_reference,
        );
      }
    }

    response.status(201).json({ data: payment });
  }),
);

router.patch(
  "/payments/:id/status",
  guard,
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z.object({ status: z.enum(["CONFIRMED", "FAILED", "REVERSED"]) }).parse(request.body);

    const updated = await transaction(async (client) => {
      const payment = await client.query<{ id: string; status: string; invoice_id: string | null; amount_rwf: string }>(
        `SELECT id,status,invoice_id,amount_rwf FROM payments WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const record = payment.rows[0];
      if (!record) throw new ApiError(404, "Payment not found", "NOT_FOUND");
      if (record.status === input.status) return record;

      // Apply or unwind the effect on the invoice balance.
      const wasApplied = record.status === "CONFIRMED";
      const willApply = input.status === "CONFIRMED";
      if (record.invoice_id && wasApplied !== willApply) {
        const delta = willApply ? Number(record.amount_rwf) : -Number(record.amount_rwf);
        await client.query(
          `UPDATE invoices
              SET amount_paid_rwf = GREATEST(amount_paid_rwf + $2, 0),
                  status = CASE
                    WHEN GREATEST(amount_paid_rwf + $2, 0) >= total_rwf - 0.01 THEN 'PAID'::invoice_status
                    WHEN GREATEST(amount_paid_rwf + $2, 0) > 0 THEN 'PARTIALLY_PAID'::invoice_status
                    ELSE 'ISSUED'::invoice_status END
            WHERE id=$1`,
          [record.invoice_id, delta],
        );
      }

      const result = await client.query(
        `UPDATE payments SET status=$2::payment_status, received_at = CASE WHEN $2::payment_status='CONFIRMED' THEN now() ELSE received_at END
          WHERE id=$1 RETURNING *`,
        [id, input.status],
      );
      return result.rows[0] as { id: string; status: string; invoice_id: string | null; amount_rwf: string };
    });

    response.json({ data: updated });
  }),
);

/* ----------------------------- finance dashboard --------------------------- */

router.get(
  "/finance/summary",
  guard,
  asyncHandler(async (_request, response) => {
    const [metrics, ageing, recent] = await Promise.all([
      query(
        `SELECT
           COALESCE(SUM(total_rwf - amount_paid_rwf) FILTER (WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')),0) AS receivables_rwf,
           COALESCE(SUM(total_rwf - amount_paid_rwf) FILTER (WHERE status IN ('ISSUED','PARTIALLY_PAID') AND due_at < now()),0) AS overdue_rwf,
           COALESCE(SUM(total_rwf) FILTER (WHERE issued_at >= date_trunc('month',now())),0) AS invoiced_this_month_rwf,
           COALESCE(SUM(vat_rwf) FILTER (WHERE issued_at >= date_trunc('month',now())),0) AS vat_this_month_rwf,
           COUNT(*) FILTER (WHERE status IN ('ISSUED','PARTIALLY_PAID') AND due_at < now())::int AS overdue_count,
           COUNT(*) FILTER (WHERE ebm_receipt_number IS NULL AND status <> 'CANCELLED')::int AS missing_ebm_count
         FROM invoices`,
      ),
      query(
        `SELECT
           COALESCE(SUM(balance) FILTER (WHERE bucket=0),0) AS current_rwf,
           COALESCE(SUM(balance) FILTER (WHERE bucket=1),0) AS days_1_30_rwf,
           COALESCE(SUM(balance) FILTER (WHERE bucket=2),0) AS days_31_60_rwf,
           COALESCE(SUM(balance) FILTER (WHERE bucket=3),0) AS days_61_90_rwf,
           COALESCE(SUM(balance) FILTER (WHERE bucket=4),0) AS days_90_plus_rwf
         FROM (
           SELECT (total_rwf - amount_paid_rwf) AS balance,
                  CASE
                    WHEN due_at >= now() THEN 0
                    WHEN now() - due_at <= interval '30 days' THEN 1
                    WHEN now() - due_at <= interval '60 days' THEN 2
                    WHEN now() - due_at <= interval '90 days' THEN 3
                    ELSE 4 END AS bucket
             FROM invoices WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')
         ) buckets`,
      ),
      query(
        `SELECT p.reference,p.method,p.amount_rwf,p.status,p.created_at,b.name AS business_name
           FROM payments p JOIN businesses b ON b.id=p.business_id ORDER BY p.created_at DESC LIMIT 8`,
      ),
    ]);

    response.json({ data: { metrics: metrics.rows[0], ageing: ageing.rows[0], recentPayments: recent.rows } });
  }),
);

export default router;
