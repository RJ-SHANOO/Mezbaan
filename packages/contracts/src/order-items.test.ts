import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AddOrderItemSchema, FireOrderItemsSchema, UpdateOrderItemSchema } from "./order-items.js";

describe("AddOrderItemSchema", () => {
  it("accepts a well-formed product item with modifiers", () => {
    const productId = randomUUID();
    const modifierOptionIds = [randomUUID(), randomUUID()];
    expect(AddOrderItemSchema.parse({ productId, quantity: 2, notes: "No onions", modifierOptionIds })).toEqual({
      productId,
      quantity: 2,
      notes: "No onions",
      modifierOptionIds,
    });
  });

  it("rejects both productId and variantId set together, and rejects neither being set", () => {
    expect(() => AddOrderItemSchema.parse({ productId: randomUUID(), variantId: randomUUID() })).toThrow();
    expect(() => AddOrderItemSchema.parse({})).toThrow();
  });

  it("rejects a zero or negative quantity", () => {
    expect(() => AddOrderItemSchema.parse({ productId: randomUUID(), quantity: 0 })).toThrow();
  });
});

describe("UpdateOrderItemSchema", () => {
  it("accepts clearing notes/seatNumber/course back to null", () => {
    expect(UpdateOrderItemSchema.parse({ notes: null, seatNumber: null, course: null })).toEqual({ notes: null, seatNumber: null, course: null });
  });
});

describe("FireOrderItemsSchema", () => {
  it("accepts itemIds alone, or course alone", () => {
    const itemIds = [randomUUID()];
    expect(FireOrderItemsSchema.parse({ itemIds })).toEqual({ itemIds });
    expect(FireOrderItemsSchema.parse({ course: "Starters" })).toEqual({ course: "Starters" });
  });

  it("rejects both itemIds and course set together, and rejects neither being set", () => {
    expect(() => FireOrderItemsSchema.parse({ itemIds: [randomUUID()], course: "Starters" })).toThrow();
    expect(() => FireOrderItemsSchema.parse({})).toThrow();
  });

  it("rejects an empty itemIds array", () => {
    expect(() => FireOrderItemsSchema.parse({ itemIds: [] })).toThrow();
  });
});
