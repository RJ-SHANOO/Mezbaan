import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CreatePriceListSchema, ResolvePriceQuerySchema, SetPriceListItemSchema } from "./price-lists.js";

describe("CreatePriceListSchema", () => {
  it("accepts a well-formed price list", () => {
    expect(CreatePriceListSchema.parse({ name: "Standard", currency: "PKR" })).toEqual({ name: "Standard", currency: "PKR" });
  });

  it("rejects an unsupported currency", () => {
    expect(() => CreatePriceListSchema.parse({ name: "Standard", currency: "NOPE" })).toThrow();
  });
});

describe("SetPriceListItemSchema", () => {
  it("accepts a product-priced item", () => {
    const productId = randomUUID();
    expect(SetPriceListItemSchema.parse({ productId, unitPriceMinor: "1500" })).toEqual({ productId, unitPriceMinor: "1500" });
  });

  it("accepts a variant-priced item", () => {
    const variantId = randomUUID();
    expect(SetPriceListItemSchema.parse({ variantId, unitPriceMinor: "1800" })).toEqual({ variantId, unitPriceMinor: "1800" });
  });

  it("rejects both productId and variantId set together, and rejects neither being set", () => {
    expect(() => SetPriceListItemSchema.parse({ productId: randomUUID(), variantId: randomUUID(), unitPriceMinor: "100" })).toThrow();
    expect(() => SetPriceListItemSchema.parse({ unitPriceMinor: "100" })).toThrow();
  });

  it("rejects a non-integer unitPriceMinor", () => {
    expect(() => SetPriceListItemSchema.parse({ productId: randomUUID(), unitPriceMinor: "15.50" })).toThrow();
  });
});

describe("ResolvePriceQuerySchema", () => {
  it("rejects both productId and variantId set together, and rejects neither being set", () => {
    const branchId = randomUUID();
    expect(() =>
      ResolvePriceQuerySchema.parse({ branchId, orderType: "dine_in", productId: randomUUID(), variantId: randomUUID() }),
    ).toThrow();
    expect(() => ResolvePriceQuerySchema.parse({ branchId, orderType: "dine_in" })).toThrow();
  });
});
