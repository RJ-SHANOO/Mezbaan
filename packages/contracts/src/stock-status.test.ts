import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClearOutOfStockQuerySchema, MarkOutOfStockSchema } from "./stock-status.js";

describe("MarkOutOfStockSchema", () => {
  it("accepts a product-scoped marking", () => {
    const branchId = randomUUID();
    const productId = randomUUID();
    expect(MarkOutOfStockSchema.parse({ branchId, productId })).toEqual({ branchId, productId });
  });

  it("accepts a variant-scoped marking with a reason", () => {
    const branchId = randomUUID();
    const variantId = randomUUID();
    expect(MarkOutOfStockSchema.parse({ branchId, variantId, reason: "Sold out" })).toEqual({ branchId, variantId, reason: "Sold out" });
  });

  it("rejects both productId and variantId set together, and rejects neither being set", () => {
    const branchId = randomUUID();
    expect(() => MarkOutOfStockSchema.parse({ branchId, productId: randomUUID(), variantId: randomUUID() })).toThrow();
    expect(() => MarkOutOfStockSchema.parse({ branchId })).toThrow();
  });
});

describe("ClearOutOfStockQuerySchema", () => {
  it("rejects both productId and variantId set together, and rejects neither being set", () => {
    const branchId = randomUUID();
    expect(() => ClearOutOfStockQuerySchema.parse({ branchId, productId: randomUUID(), variantId: randomUUID() })).toThrow();
    expect(() => ClearOutOfStockQuerySchema.parse({ branchId })).toThrow();
  });
});
