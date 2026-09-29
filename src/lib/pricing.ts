import type { PoolClient } from "pg";
import { query } from "../db.js";

export type PriceBreak = { min_quantity: number; unit_price_rwf: string };

export type PricedLine = {
  productId: string;
  quantity: number;
  listPriceRwf: number;
  unitPriceRwf: number;
  lineTotalRwf: number;
  vatRate: number;
  vatRwf: number;
};

/** RWF is quoted without a minor unit in trade; keep 2dp for the numeric column. */
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Wholesale unit price for a quantity, honouring (in order):
 *   1. volume price breaks on the product — the best break the quantity reaches
 *   2. the client's contract tier discount, applied to whatever price 1 produced
 */
export function resolveUnitPrice(listPriceRwf: number, breaks: PriceBreak[], quantity: number, tierDiscountPercent: number) {
  const applicable = breaks
    .filter((entry) => quantity >= entry.min_quantity)
    .sort((a, b) => b.min_quantity - a.min_quantity)[0];
  const base = applicable ? Number(applicable.unit_price_rwf) : listPriceRwf;
  return round(base * (1 - tierDiscountPercent / 100));
}

export function priceLine(input: {
  productId: string;
  quantity: number;
  listPriceRwf: number;
  vatRate: number;
  breaks: PriceBreak[];
  tierDiscountPercent: number;
}): PricedLine {
  const unitPriceRwf = resolveUnitPrice(input.listPriceRwf, input.breaks, input.quantity, input.tierDiscountPercent);
  const lineTotalRwf = round(unitPriceRwf * input.quantity);
  return {
    productId: input.productId,
    quantity: input.quantity,
    listPriceRwf: input.listPriceRwf,
    unitPriceRwf,
    lineTotalRwf,
    vatRate: input.vatRate,
    vatRwf: round(lineTotalRwf * input.vatRate),
  };
}

export function summarise(lines: PricedLine[], deliveryFeeRwf = 0) {
  const subtotalRwf = round(lines.reduce((sum, line) => sum + line.lineTotalRwf, 0));
  const vatRwf = round(lines.reduce((sum, line) => sum + line.vatRwf, 0));
  const discountRwf = round(lines.reduce((sum, line) => sum + (line.listPriceRwf - line.unitPriceRwf) * line.quantity, 0));
  return {
    subtotalRwf,
    vatRwf,
    discountRwf,
    deliveryFeeRwf: round(deliveryFeeRwf),
    totalRwf: round(subtotalRwf + vatRwf + deliveryFeeRwf),
  };
}

/** Price breaks for a set of products, grouped by product id. */
export async function loadPriceBreaks(productIds: string[], client?: PoolClient) {
  const run = client ? client.query.bind(client) : query;
  const result = await run(
    `SELECT product_id, min_quantity, unit_price_rwf FROM product_price_breaks WHERE product_id = ANY($1::uuid[]) ORDER BY min_quantity`,
    [productIds],
  );
  const grouped = new Map<string, PriceBreak[]>();
  for (const row of result.rows as Array<PriceBreak & { product_id: string }>) {
    const list = grouped.get(row.product_id) ?? [];
    list.push({ min_quantity: row.min_quantity, unit_price_rwf: row.unit_price_rwf });
    grouped.set(row.product_id, list);
  }
  return grouped;
}

export async function tierDiscountFor(businessId: string, client?: PoolClient) {
  const run = client ? client.query.bind(client) : query;
  const result = await run(
    `SELECT COALESCE(t.discount_percent, 0) AS discount_percent, COALESCE(t.name,'Standard wholesale') AS name
       FROM businesses b LEFT JOIN price_tiers t ON t.id = b.price_tier_id WHERE b.id = $1`,
    [businessId],
  );
  const row = result.rows[0] as { discount_percent: string; name: string } | undefined;
  return { discountPercent: Number(row?.discount_percent ?? 0), tierName: row?.name ?? "Standard wholesale" };
}
