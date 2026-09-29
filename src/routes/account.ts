import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { authenticate, requireApprovedClient } from "../middleware/authenticate.js";
import { creditPosition } from "../lib/credit.js";

const router = Router();
router.use(authenticate, requireApprovedClient);

/* --------------------------------- profile --------------------------------- */

router.get(
  "/",
  asyncHandler(async (request, response) => {
    const businessId = request.auth!.businessId!;
    const [business, credit] = await Promise.all([
      query(
        `SELECT b.id,b.name,b.type,b.registration_number,b.tin,b.vat_registration_number,b.pharmacy_licence_number,
                b.operating_licence_number,b.street_address,b.district,b.country,b.whatsapp,b.status,b.approved_at,
                b.credit_limit_rwf,b.payment_terms_days,b.credit_hold,
                t.name AS price_tier, t.discount_percent,
                json_build_object('fullName',u.full_name,'email',u.email,'phone',u.phone,'jobTitle',u.job_title,
                                  'preferredLanguage',u.preferred_language) AS contact
           FROM businesses b
           JOIN users u ON u.id = $2
           LEFT JOIN price_tiers t ON t.id = b.price_tier_id
          WHERE b.id = $1`,
        [businessId, request.auth!.userId],
      ),
      creditPosition(businessId),
    ]);
    if (!business.rowCount) throw new ApiError(404, "Account not found", "NOT_FOUND");
    response.json({ data: { ...business.rows[0], credit } });
  }),
);

router.patch(
  "/",
  asyncHandler(async (request, response) => {
    const input = z
      .object({
        fullName: z.string().min(2).max(150).optional(),
        jobTitle: z.string().min(2).max(100).optional(),
        phone: z.string().min(8).max(30).optional(),
        preferredLanguage: z.enum(["en", "fr", "rw"]).optional(),
        whatsapp: z.string().max(30).optional(),
      })
      .parse(request.body);

    await transaction(async (client) => {
      const userFields: Array<[string, unknown]> = [];
      if (input.fullName !== undefined) userFields.push(["full_name", input.fullName]);
      if (input.jobTitle !== undefined) userFields.push(["job_title", input.jobTitle]);
      if (input.phone !== undefined) userFields.push(["phone", input.phone]);
      if (input.preferredLanguage !== undefined) userFields.push(["preferred_language", input.preferredLanguage]);

      if (userFields.length) {
        const assignments = userFields.map(([column], index) => `${column}=$${index + 1}`).join(",");
        await client.query(`UPDATE users SET ${assignments} WHERE id=$${userFields.length + 1}`, [
          ...userFields.map(([, value]) => value),
          request.auth!.userId,
        ]);
      }
      if (input.whatsapp !== undefined) {
        await client.query(`UPDATE businesses SET whatsapp=$1 WHERE id=$2`, [input.whatsapp, request.auth!.businessId]);
      }
    });

    response.json({ message: "Your details have been updated." });
  }),
);

/* ---------------------------- delivery addresses ---------------------------- */

const addressSchema = z.object({
  label: z.string().min(2).max(80),
  recipientName: z.string().min(2).max(150),
  phone: z.string().min(8).max(30),
  streetAddress: z.string().min(3).max(250),
  district: z.string().min(2).max(100),
  country: z.string().min(2).max(100).default("Rwanda"),
  isDefault: z.boolean().default(false),
});

router.get(
  "/addresses",
  asyncHandler(async (request, response) => {
    const result = await query(
      `SELECT id,label,recipient_name,phone,street_address,district,country,is_default,created_at
         FROM delivery_addresses WHERE business_id = $1 ORDER BY is_default DESC, label`,
      [request.auth!.businessId],
    );
    response.json({ data: result.rows });
  }),
);

router.post(
  "/addresses",
  asyncHandler(async (request, response) => {
    const input = addressSchema.parse(request.body);
    const businessId = request.auth!.businessId!;

    const created = await transaction(async (client) => {
      await client.query(`SELECT id FROM businesses WHERE id=$1 FOR UPDATE`, [businessId]);
      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM delivery_addresses WHERE business_id = $1`,
        [businessId],
      );
      if (Number(count.rows[0]!.count) >= 20) {
        throw new ApiError(422, "You have reached the maximum of 20 saved addresses", "ADDRESS_LIMIT");
      }
      // The first address on an account is always the default.
      const isDefault = input.isDefault || Number(count.rows[0]!.count) === 0;
      if (isDefault) await client.query(`UPDATE delivery_addresses SET is_default=false WHERE business_id=$1`, [businessId]);

      const result = await client.query(
        `INSERT INTO delivery_addresses(business_id,label,recipient_name,phone,street_address,district,country,is_default)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [businessId, input.label, input.recipientName, input.phone, input.streetAddress, input.district, input.country, isDefault],
      );
      return result.rows[0];
    });

    response.status(201).json({ data: created });
  }),
);

router.patch(
  "/addresses/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = addressSchema.partial().parse(request.body);
    const businessId = request.auth!.businessId!;

    const updated = await transaction(async (client) => {
      if (input.isDefault) {
        await client.query(`SELECT id FROM businesses WHERE id=$1 FOR UPDATE`, [businessId]);
        await client.query(`UPDATE delivery_addresses SET is_default=false WHERE business_id=$1`, [businessId]);
      }

      const columns: Record<string, string> = {
        label: "label",
        recipientName: "recipient_name",
        phone: "phone",
        streetAddress: "street_address",
        district: "district",
        country: "country",
        isDefault: "is_default",
      };
      const entries = Object.entries(input).filter(([key]) => columns[key]);
      if (!entries.length) throw new ApiError(422, "No changes supplied", "EMPTY_UPDATE");

      const assignments = entries.map(([key], index) => `${columns[key]}=$${index + 1}`).join(",");
      const values = entries.map(([, value]) => value);
      const result = await client.query(
        `UPDATE delivery_addresses SET ${assignments} WHERE id=$${values.length + 1} AND business_id=$${values.length + 2} RETURNING *`,
        [...values, id, businessId],
      );
      if (!result.rowCount) throw new ApiError(404, "Address not found", "NOT_FOUND");
      return result.rows[0];
    });

    response.json({ data: updated });
  }),
);

router.delete(
  "/addresses/:id",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const result = await query(
      `DELETE FROM delivery_addresses WHERE id=$1 AND business_id=$2 AND is_default=false RETURNING id`,
      [id, request.auth!.businessId],
    );
    if (!result.rowCount) {
      throw new ApiError(422, "That address could not be removed. The default address cannot be deleted.", "ADDRESS_NOT_REMOVABLE");
    }
    response.json({ ok: true });
  }),
);

/* -------------------------- invoices & statement --------------------------- */

router.get(
  "/invoices",
  asyncHandler(async (request, response) => {
    const result = await query(
      `SELECT i.id,i.reference,i.status,i.issued_at,i.due_at,i.subtotal_rwf,i.vat_rwf,i.total_rwf,i.amount_paid_rwf,
              (i.total_rwf - i.amount_paid_rwf) AS balance_rwf, i.ebm_receipt_number,
              o.reference AS order_reference, o.id AS order_id,
              (i.status IN ('ISSUED','PARTIALLY_PAID') AND i.due_at < now()) AS is_overdue
         FROM invoices i JOIN orders o ON o.id = i.order_id
        WHERE i.business_id = $1 ORDER BY i.issued_at DESC LIMIT 200`,
      [request.auth!.businessId],
    );
    response.json({ data: result.rows });
  }),
);

router.get(
  "/payments",
  asyncHandler(async (request, response) => {
    const result = await query(
      `SELECT p.id,p.reference,p.method,p.status,p.amount_rwf,p.external_reference,p.received_at,p.created_at,
              i.reference AS invoice_reference
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE p.business_id = $1 ORDER BY p.created_at DESC LIMIT 200`,
      [request.auth!.businessId],
    );
    response.json({ data: result.rows });
  }),
);

/** Headline numbers for the client dashboard. */
router.get(
  "/summary",
  asyncHandler(async (request, response) => {
    const businessId = request.auth!.businessId!;
    const [metrics, recent, credit] = await Promise.all([
      query(
        `SELECT
           (SELECT COUNT(*)::int FROM orders WHERE business_id=$1 AND status IN ('SUBMITTED','PROCESSING','SHIPPED')) AS open_orders,
           (SELECT COUNT(*)::int FROM orders WHERE business_id=$1) AS lifetime_orders,
           (SELECT COALESCE(SUM(total_rwf),0) FROM orders WHERE business_id=$1 AND status <> 'CANCELLED'
              AND created_at >= date_trunc('month', now())) AS month_spend_rwf,
           (SELECT COUNT(*)::int FROM invoices WHERE business_id=$1 AND status IN ('ISSUED','PARTIALLY_PAID') AND due_at < now()) AS overdue_invoices,
           (SELECT COUNT(*)::int FROM cart_items WHERE business_id=$1) AS cart_lines`,
        [businessId],
      ),
      query(
        `SELECT o.id,o.reference,o.status,o.total_rwf,o.created_at,o.tracking_number,
                COUNT(i.id)::int AS item_count
           FROM orders o LEFT JOIN order_items i ON i.order_id=o.id
          WHERE o.business_id=$1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 5`,
        [businessId],
      ),
      creditPosition(businessId),
    ]);

    const frequent = await query(
      `SELECT i.product_id, i.product_name, i.sku, SUM(i.quantity)::int AS total_quantity, MAX(o.created_at) AS last_ordered,
              p.image_urls, p.unit_price_rwf, p.stock_status, b.name AS brand_name
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
         JOIN products p ON p.id = i.product_id
         JOIN brands b ON b.id = p.brand_id
        WHERE o.business_id = $1 AND o.status <> 'CANCELLED' AND p.is_active
        GROUP BY i.product_id, i.product_name, i.sku, p.image_urls, p.unit_price_rwf, p.stock_status, b.name
        ORDER BY total_quantity DESC LIMIT 6`,
      [businessId],
    );

    response.json({ data: { metrics: metrics.rows[0], recentOrders: recent.rows, frequentProducts: frequent.rows, credit } });
  }),
);

export default router;
