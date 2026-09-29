import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { query } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { requirePermission } from "../../middleware/authenticate.js";

const router = Router();

/* --------------------------- operational dashboard -------------------------- */

router.get(
  "/dashboard",
  asyncHandler(async (_request, response) => {
    const [metrics, monthly, recentOrders, pending, stock, expiring] = await Promise.all([
      query(
        `SELECT
           (SELECT COUNT(*)::int FROM businesses WHERE status='APPROVED') AS active_clients,
           (SELECT COUNT(*)::int FROM businesses WHERE status='PENDING') AS pending_applications,
           (SELECT COUNT(*)::int FROM orders WHERE status IN ('SUBMITTED','PROCESSING','SHIPPED')) AS active_orders,
           (SELECT COALESCE(SUM(total_rwf),0) FROM orders
             WHERE status <> 'CANCELLED' AND created_at >= date_trunc('month',now())) AS month_revenue_rwf,
           (SELECT COALESCE(SUM(total_rwf),0) FROM orders
             WHERE status <> 'CANCELLED'
               AND created_at >= date_trunc('month',now()) - interval '1 month'
               AND created_at <  date_trunc('month',now())) AS previous_month_revenue_rwf,
           (SELECT COUNT(*)::int FROM products WHERE is_active AND stock_status IN ('LOW_STOCK','OUT_OF_STOCK')) AS stock_alerts,
           (SELECT COUNT(*)::int FROM products WHERE is_active) AS active_products,
           (SELECT COUNT(*)::int FROM brands WHERE is_active) AS active_brands,
           (SELECT COALESCE(SUM(stock_quantity),0)::int FROM products WHERE is_active) AS total_stock_units,
           (SELECT COALESCE(SUM(total_rwf - amount_paid_rwf),0) FROM invoices
             WHERE status IN ('ISSUED','PARTIALLY_PAID') AND due_at < now()) AS overdue_rwf,
           (SELECT COUNT(*)::int FROM returns WHERE status='REQUESTED') AS open_returns`,
      ),
      query(
        `SELECT to_char(month,'Mon') AS label,
                to_char(month,'YYYY-MM') AS period,
                COALESCE(SUM(o.total_rwf) FILTER (WHERE o.status <> 'CANCELLED'),0) AS revenue_rwf,
                COUNT(o.id) FILTER (WHERE o.status <> 'CANCELLED')::int AS order_count
           FROM generate_series(date_trunc('month',now()) - interval '11 months', date_trunc('month',now()), interval '1 month') month
           LEFT JOIN orders o ON date_trunc('month',o.created_at)=month
          GROUP BY month ORDER BY month`,
      ),
      query(
        `SELECT o.id,o.reference,o.status,o.total_rwf,o.created_at,b.name AS business_name
           FROM orders o JOIN businesses b ON b.id=o.business_id ORDER BY o.created_at DESC LIMIT 6`,
      ),
      query(
        `SELECT b.id,b.name,b.type,b.created_at,b.district,u.full_name AS contact_name
           FROM businesses b JOIN users u ON u.business_id=b.id AND u.role='CLIENT'
          WHERE b.status='PENDING' ORDER BY b.created_at LIMIT 6`,
      ),
      query(
        `SELECT p.id,p.name,p.sku,p.stock_quantity,p.reorder_level,p.stock_status,b.name AS brand_name
           FROM products p JOIN brands b ON b.id=p.brand_id
          WHERE p.is_active AND p.stock_status IN ('LOW_STOCK','OUT_OF_STOCK')
          ORDER BY p.stock_quantity LIMIT 6`,
      ),
      query(
        `SELECT pb.id,pb.batch_number,pb.expiry_date,pb.quantity_remaining,
                (pb.expiry_date - CURRENT_DATE)::int AS days_remaining,
                p.name AS product_name,p.sku
           FROM product_batches pb JOIN products p ON p.id=pb.product_id
          WHERE pb.quantity_remaining>0 AND pb.recalled_at IS NULL
            AND pb.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1||' days')::interval
          ORDER BY pb.expiry_date LIMIT 6`,
        [String(config.EXPIRY_ALERT_DAYS)],
      ),
    ]);

    response.json({
      data: {
        metrics: metrics.rows[0],
        monthlyRevenue: monthly.rows,
        recentOrders: recentOrders.rows,
        pendingApplications: pending.rows,
        stockAlerts: stock.rows,
        expiringBatches: expiring.rows,
      },
    });
  }),
);

/* ------------------------------ deep analytics ------------------------------ */

router.get(
  "/analytics",
  requirePermission("analytics"),
  asyncHandler(async (request, response) => {
    const days = z.coerce.number().int().min(7).max(730).default(90).parse(request.query.days ?? 90);
    const window = String(days);

    const [trend, topProducts, topClients, brandMix, statusMix, funnel, districts] = await Promise.all([
      query(
        `SELECT to_char(day,'YYYY-MM-DD') AS date,
                COALESCE(SUM(o.total_rwf) FILTER (WHERE o.status <> 'CANCELLED'),0) AS revenue_rwf,
                COUNT(o.id) FILTER (WHERE o.status <> 'CANCELLED')::int AS order_count
           FROM generate_series(CURRENT_DATE - ($1||' days')::interval, CURRENT_DATE, interval '1 day') day
           LEFT JOIN orders o ON date_trunc('day',o.created_at)=day
          GROUP BY day ORDER BY day`,
        [window],
      ),
      query(
        `SELECT i.product_name,i.sku,SUM(i.quantity)::int AS units,SUM(i.line_total_rwf) AS revenue_rwf,
                COUNT(DISTINCT o.business_id)::int AS buyer_count
           FROM order_items i JOIN orders o ON o.id=i.order_id
          WHERE o.status <> 'CANCELLED' AND o.created_at >= now() - ($1||' days')::interval
          GROUP BY i.product_name,i.sku ORDER BY revenue_rwf DESC LIMIT 10`,
        [window],
      ),
      query(
        `SELECT b.id,b.name,b.district,COUNT(o.id)::int AS order_count,SUM(o.total_rwf) AS revenue_rwf,
                MAX(o.created_at) AS last_order_at
           FROM orders o JOIN businesses b ON b.id=o.business_id
          WHERE o.status <> 'CANCELLED' AND o.created_at >= now() - ($1||' days')::interval
          GROUP BY b.id ORDER BY revenue_rwf DESC LIMIT 10`,
        [window],
      ),
      query(
        `SELECT br.name AS brand_name,SUM(i.line_total_rwf) AS revenue_rwf,SUM(i.quantity)::int AS units
           FROM order_items i
           JOIN orders o ON o.id=i.order_id
           JOIN products p ON p.id=i.product_id
           JOIN brands br ON br.id=p.brand_id
          WHERE o.status <> 'CANCELLED' AND o.created_at >= now() - ($1||' days')::interval
          GROUP BY br.name ORDER BY revenue_rwf DESC LIMIT 8`,
        [window],
      ),
      query(
        `SELECT status,COUNT(*)::int AS count,COALESCE(SUM(total_rwf),0) AS value_rwf
           FROM orders WHERE created_at >= now() - ($1||' days')::interval GROUP BY status ORDER BY count DESC`,
        [window],
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
           COUNT(*) FILTER (WHERE status='APPROVED')::int AS approved,
           COUNT(*) FILTER (WHERE status='REJECTED')::int AS rejected,
           COUNT(*) FILTER (WHERE status='SUSPENDED')::int AS suspended,
           COALESCE(AVG(EXTRACT(epoch FROM (approved_at - created_at))/3600) FILTER (WHERE approved_at IS NOT NULL),0) AS avg_approval_hours
         FROM businesses`,
      ),
      query(
        `SELECT b.district,COUNT(DISTINCT b.id)::int AS client_count,
                COALESCE(SUM(o.total_rwf) FILTER (WHERE o.status <> 'CANCELLED'),0) AS revenue_rwf
           FROM businesses b LEFT JOIN orders o ON o.business_id=b.id
          WHERE b.status='APPROVED' GROUP BY b.district ORDER BY revenue_rwf DESC LIMIT 10`,
      ),
    ]);

    // Average order value and repeat rate, derived rather than stored.
    const behaviour = await query(
      `SELECT
         COALESCE(AVG(total_rwf),0) AS average_order_value_rwf,
         COUNT(*)::int AS order_count,
         COUNT(DISTINCT business_id)::int AS buying_clients,
         COALESCE(
           COUNT(DISTINCT business_id) FILTER (WHERE business_orders > 1)::numeric
           / NULLIF(COUNT(DISTINCT business_id),0) * 100, 0) AS repeat_rate_percent
       FROM (
         SELECT o.*, COUNT(*) OVER (PARTITION BY o.business_id) AS business_orders
           FROM orders o
          WHERE o.status <> 'CANCELLED' AND o.created_at >= now() - ($1||' days')::interval
       ) scoped`,
      [window],
    );

    response.json({
      data: {
        days,
        trend: trend.rows,
        topProducts: topProducts.rows,
        topClients: topClients.rows,
        brandMix: brandMix.rows,
        statusMix: statusMix.rows,
        registrationFunnel: funnel.rows[0],
        districts: districts.rows,
        behaviour: behaviour.rows[0],
      },
    });
  }),
);

/* ------------------------------- documents list ----------------------------- */

router.get(
  "/documents",
  requirePermission("registrations"),
  asyncHandler(async (request, response) => {
    const filters = z
      .object({
        status: z.enum(["all", "verified", "unverified", "rejected"]).default("all"),
        search: z.string().max(100).optional(),
      })
      .parse(request.query);

    const result = await query(
      `SELECT d.id,d.type,d.original_name,d.mime_type,d.size_bytes,d.provider,d.verified_at,d.rejection_reason,
              d.uploaded_at, b.id AS business_id,b.name AS business_name,b.status AS business_status,
              v.full_name AS verified_by_name
         FROM registration_documents d
         JOIN businesses b ON b.id=d.business_id
         LEFT JOIN users v ON v.id=d.verified_by
        WHERE ($1='all'
               OR ($1='verified'   AND d.verified_at IS NOT NULL)
               OR ($1='unverified' AND d.verified_at IS NULL AND d.rejection_reason IS NULL)
               OR ($1='rejected'   AND d.rejection_reason IS NOT NULL))
          AND ($2::text IS NULL OR b.name ILIKE '%'||$2||'%' OR d.original_name ILIKE '%'||$2||'%')
        ORDER BY d.uploaded_at DESC LIMIT 500`,
      [filters.status, filters.search ?? null],
    );
    response.json({ data: result.rows });
  }),
);

export default router;
