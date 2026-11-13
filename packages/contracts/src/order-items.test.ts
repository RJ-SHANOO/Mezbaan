import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AddOrderItemSchema, UpdateOrderItemSchema } from "./order-items.js";

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
