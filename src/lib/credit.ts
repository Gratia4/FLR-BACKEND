import type { PoolClient } from "pg";
import { query } from "../db.js";
import { ApiError } from "./errors.js";

export type CreditPosition = {
  creditLimitRwf: number;
  paymentTermsDays: number;
  creditHold: boolean;
  outstandingRwf: number;
  overdueRwf: number;
  availableRwf: number;
};

/**
 * Exposure = issued-but-unpaid invoices, plus orders that are in flight and
 * have not been invoiced yet. Without the second term a client could place
 * unlimited orders in the window before invoicing catches up.
 */
export async function creditPosition(businessId: string, client?: PoolClient): Promise<CreditPosition> {
  const run = client ? client.query.bind(client) : query;
  const result = await run(
    `SELECT
       b.credit_limit_rwf,
       b.payment_terms_days,
       b.credit_hold,
       COALESCE((SELECT SUM(i.total_rwf - i.amount_paid_rwf) FROM invoices i
                  WHERE i.business_id = b.id AND i.status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')), 0) AS invoiced_outstanding,
       COALESCE((SELECT SUM(i.total_rwf - i.amount_paid_rwf) FROM invoices i
                  WHERE i.business_id = b.id AND i.status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')
                    AND i.due_at < now()), 0) AS overdue,
       COALESCE((SELECT SUM(o.total_rwf) FROM orders o
                  WHERE o.business_id = b.id
                    AND o.status IN ('SUBMITTED','PROCESSING','SHIPPED','DELIVERED')
                    AND NOT EXISTS (SELECT 1 FROM invoices i2 WHERE i2.order_id = o.id)), 0) AS uninvoiced
     FROM businesses b WHERE b.id = $1`,
    [businessId],
  );
  const row = result.rows[0] as
    | { credit_limit_rwf: string; payment_terms_days: number; credit_hold: boolean; invoiced_outstanding: string; overdue: string; uninvoiced: string }
    | undefined;
  if (!row) throw new ApiError(404, "Business not found", "NOT_FOUND");

  const creditLimitRwf = Number(row.credit_limit_rwf);
  const outstandingRwf = Number(row.invoiced_outstanding) + Number(row.uninvoiced);
  return {
    creditLimitRwf,
    paymentTermsDays: row.payment_terms_days,
    creditHold: row.credit_hold,
    outstandingRwf,
    overdueRwf: Number(row.overdue),
    availableRwf: Math.max(creditLimitRwf - outstandingRwf, 0),
  };
}

/**
 * A credit limit of 0 means prepayment only — no credit is extended, so orders
 * are allowed through and settled before dispatch. Anything above 0 is enforced.
 */
export function assertCreditAvailable(position: CreditPosition, orderTotalRwf: number) {
  if (position.creditHold) {
    throw new ApiError(422, "This account is on credit hold. Please contact your FLR account manager.", "CREDIT_HOLD");
  }
  if (position.overdueRwf > 0) {
    throw new ApiError(
      422,
      `This account has ${formatRwf(position.overdueRwf)} in overdue invoices. Settle the balance before placing a new order.`,
      "CREDIT_OVERDUE",
      { overdueRwf: position.overdueRwf },
    );
  }
  if (position.creditLimitRwf > 0 && orderTotalRwf > position.availableRwf) {
    throw new ApiError(
      422,
      `This order of ${formatRwf(orderTotalRwf)} exceeds the ${formatRwf(position.availableRwf)} of credit still available on your account.`,
      "CREDIT_LIMIT_EXCEEDED",
      { availableRwf: position.availableRwf, orderTotalRwf },
    );
  }
}

const formatRwf = (value: number) => `RWF ${new Intl.NumberFormat("en-RW", { maximumFractionDigits: 0 }).format(value)}`;
