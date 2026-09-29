import type { PoolClient } from "pg";
import { ApiError } from "./errors.js";
import { loadPriceBreaks, priceLine, summarise, tierDiscountFor, type PricedLine } from "./pricing.js";

export type RequestedItem = { productId: string; quantity: number };

export type ProductRow = {
  id: string;
  sku: string;
  name: string;
  size: string;
  image_urls: string[];
  unit_price_rwf: string;
  vat_rate: string;
  minimum_order_quantity: number;
  case_size: number;
  stock_quantity: number;
  stock_status: string;
  requires_prescription: boolean;
  cold_chain: boolean;
  brand_name: string;
};

export type BuiltLine = PricedLine & { product: ProductRow };

/**
 * Turns a set of requested items into priced, validated order lines.
 *
 * `lock` takes a row lock on each product; use it when the result will be
 * committed (checkout) and omit it for read-only previews such as the cart.
 */
export async function buildOrderLines(
  client: PoolClient,
  businessId: string,
  items: RequestedItem[],
  options: { lock?: boolean; enforceStock?: boolean } = {},
) {
  const { lock = false, enforceStock = true } = options;
  if (!items.length) throw new ApiError(422, "Add at least one product before continuing", "EMPTY_ORDER");

  const ids = [...new Set(items.map((item) => item.productId))];
  const products = await client.query<ProductRow>(
    `SELECT p.id,p.sku,p.name,p.size,p.image_urls,p.unit_price_rwf,p.vat_rate,p.minimum_order_quantity,
            p.case_size,p.stock_quantity,p.stock_status,p.requires_prescription,p.cold_chain,b.name AS brand_name
       FROM products p JOIN brands b ON b.id = p.brand_id
      WHERE p.id = ANY($1::uuid[]) AND p.is_active AND b.is_active${lock ? " FOR UPDATE OF p" : ""}`,
    [ids],
  );

  if (products.rows.length !== ids.length) {
    const found = new Set(products.rows.map((row) => row.id));
    throw new ApiError(422, "One or more products are no longer available", "PRODUCT_UNAVAILABLE", {
      productIds: ids.filter((id) => !found.has(id)),
    });
  }

  const [{ discountPercent, tierName }, breaks] = await Promise.all([
    tierDiscountFor(businessId, client),
    loadPriceBreaks(ids, client),
  ]);

  const lines: BuiltLine[] = items.map((item) => {
    const product = products.rows.find((candidate) => candidate.id === item.productId)!;

    if (item.quantity < product.minimum_order_quantity) {
      throw new ApiError(
        422,
        `${product.name} has a minimum order quantity of ${product.minimum_order_quantity}`,
        "MOQ_NOT_MET",
        { productId: product.id, minimumOrderQuantity: product.minimum_order_quantity },
      );
    }
    if (product.case_size > 1 && item.quantity % product.case_size !== 0) {
      throw new ApiError(
        422,
        `${product.name} is sold in cases of ${product.case_size}. Adjust the quantity to a multiple of ${product.case_size}.`,
        "CASE_SIZE_MISMATCH",
        { productId: product.id, caseSize: product.case_size },
      );
    }
    if (enforceStock && product.stock_status !== "PRE_ORDER" && item.quantity > product.stock_quantity) {
      throw new ApiError(
        422,
        `Only ${product.stock_quantity} unit${product.stock_quantity === 1 ? "" : "s"} of ${product.name} are in stock`,
        "INSUFFICIENT_STOCK",
        { productId: product.id, available: product.stock_quantity },
      );
    }

    return {
      ...priceLine({
        productId: product.id,
        quantity: item.quantity,
        listPriceRwf: Number(product.unit_price_rwf),
        vatRate: Number(product.vat_rate),
        breaks: breaks.get(product.id) ?? [],
        tierDiscountPercent: discountPercent,
      }),
      product,
    };
  });

  return { lines, totals: summarise(lines), tier: { name: tierName, discountPercent } };
}
