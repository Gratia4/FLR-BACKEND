import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertCreditAvailable, type CreditPosition } from "./credit.js";
import { ApiError } from "./errors.js";

const position = (overrides: Partial<CreditPosition> = {}): CreditPosition => ({
  creditLimitRwf: 1_000_000,
  paymentTermsDays: 30,
  creditHold: false,
  outstandingRwf: 0,
  overdueRwf: 0,
  availableRwf: 1_000_000,
  ...overrides,
});

const codeOf = (run: () => void) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ApiError ? error.code : "UNEXPECTED";
  }
};

describe("assertCreditAvailable", () => {
  it("allows an order inside the remaining limit", () => {
    assert.equal(codeOf(() => assertCreditAvailable(position(), 999_999)), null);
  });

  it("blocks an order that exceeds the available credit", () => {
    const state = position({ outstandingRwf: 800_000, availableRwf: 200_000 });
    assert.equal(codeOf(() => assertCreditAvailable(state, 250_000)), "CREDIT_LIMIT_EXCEEDED");
  });

  it("blocks any order while an invoice is overdue", () => {
    assert.equal(codeOf(() => assertCreditAvailable(position({ overdueRwf: 1 }), 100)), "CREDIT_OVERDUE");
  });

  it("blocks an account on credit hold before anything else", () => {
    assert.equal(codeOf(() => assertCreditAvailable(position({ creditHold: true }), 1)), "CREDIT_HOLD");
  });

  it("treats a zero limit as prepayment rather than a block", () => {
    const state = position({ creditLimitRwf: 0, availableRwf: 0 });
    assert.equal(codeOf(() => assertCreditAvailable(state, 5_000_000)), null);
  });
});
