import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { priceLine, resolveUnitPrice, summarise } from "./pricing.js";

describe("resolveUnitPrice", () => {
  it("returns the list price when no break applies", () => {
    assert.equal(resolveUnitPrice(1000, [{ min_quantity: 50, unit_price_rwf: "900" }], 10, 0), 1000);
  });

  it("uses the best break the quantity reaches", () => {
    const breaks = [
      { min_quantity: 12, unit_price_rwf: "950" },
      { min_quantity: 50, unit_price_rwf: "880" },
      { min_quantity: 100, unit_price_rwf: "820" },
    ];
    assert.equal(resolveUnitPrice(1000, breaks, 60, 0), 880);
    assert.equal(resolveUnitPrice(1000, breaks, 100, 0), 820);
    assert.equal(resolveUnitPrice(1000, breaks, 11, 0), 1000);
  });

  it("applies the contract tier discount on top of the break price", () => {
    assert.equal(resolveUnitPrice(1000, [{ min_quantity: 12, unit_price_rwf: "900" }], 24, 6), 846);
  });
});

describe("priceLine", () => {
  it("computes VAT on the discounted line total, not the list price", () => {
    const line = priceLine({
      productId: "p1",
      quantity: 10,
      listPriceRwf: 1000,
      vatRate: 0.18,
      breaks: [],
      tierDiscountPercent: 10,
    });
    assert.equal(line.unitPriceRwf, 900);
    assert.equal(line.lineTotalRwf, 9000);
    assert.equal(line.vatRwf, 1620);
  });

  it("charges no VAT on an exempt product", () => {
    const line = priceLine({ productId: "p2", quantity: 4, listPriceRwf: 2500, vatRate: 0, breaks: [], tierDiscountPercent: 0 });
    assert.equal(line.vatRwf, 0);
    assert.equal(line.lineTotalRwf, 10000);
  });
});

describe("summarise", () => {
  it("adds VAT and delivery to the subtotal and reports the discount given", () => {
    const lines = [
      priceLine({ productId: "a", quantity: 10, listPriceRwf: 1000, vatRate: 0.18, breaks: [], tierDiscountPercent: 10 }),
      priceLine({ productId: "b", quantity: 5, listPriceRwf: 2000, vatRate: 0, breaks: [], tierDiscountPercent: 10 }),
    ];
    const totals = summarise(lines, 5000);

    assert.equal(totals.subtotalRwf, 9000 + 9000);
    assert.equal(totals.vatRwf, 1620);
    assert.equal(totals.discountRwf, 1000 + 1000);
    assert.equal(totals.totalRwf, 18000 + 1620 + 5000);
  });

  it("mixing rated and exempt lines only taxes the rated ones", () => {
    const lines = [
      priceLine({ productId: "a", quantity: 1, listPriceRwf: 10000, vatRate: 0.18, breaks: [], tierDiscountPercent: 0 }),
      priceLine({ productId: "b", quantity: 1, listPriceRwf: 10000, vatRate: 0, breaks: [], tierDiscountPercent: 0 }),
    ];
    assert.equal(summarise(lines).vatRwf, 1800);
  });
});
