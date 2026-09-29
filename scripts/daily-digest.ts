/**
 * Inventory watchdog. Run from a scheduler (Railway cron) once a day:
 *   npm run digest
 * Sends the ops team a summary of low stock and expiring/expired batches.
 */
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { mails } from "../src/lib/mailer.js";

async function run() {
  if (!config.OPS_NOTIFICATION_EMAIL) {
    console.warn("OPS_NOTIFICATION_EMAIL is not set — nothing to send.");
    return;
  }

  const result = await pool.query<{ low_stock: number; expiring: number; expired: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM products WHERE is_active AND stock_status IN ('LOW_STOCK','OUT_OF_STOCK')) AS low_stock,
       (SELECT COUNT(*)::int FROM product_batches
         WHERE quantity_remaining>0 AND recalled_at IS NULL
           AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1||' days')::interval) AS expiring,
       (SELECT COUNT(*)::int FROM product_batches WHERE quantity_remaining>0 AND expiry_date < CURRENT_DATE) AS expired`,
    [String(config.EXPIRY_ALERT_DAYS)],
  );

  const row = result.rows[0]!;
  if (row.low_stock === 0 && row.expiring === 0 && row.expired === 0) {
    console.info("Nothing to report — no low stock and no expiring batches.");
    return;
  }

  await mails.stockDigest(config.OPS_NOTIFICATION_EMAIL, row.low_stock, row.expiring, row.expired);
  console.info(`Digest sent: ${row.low_stock} low, ${row.expiring} expiring, ${row.expired} expired.`);
}

run()
  .catch((error) => {
    console.error("Digest failed", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
