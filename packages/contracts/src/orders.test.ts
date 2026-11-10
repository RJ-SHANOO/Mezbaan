import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CreateOrderSchema } from "./orders.js";

describe("CreateOrderSchema", () => {
  it("accepts a dine-in order with a tableId", () => {
    const branchId = randomUUID();
    const tableId = randomUUID();
    expect(CreateOrderSchema.parse({ branchId, orderType: "dine_in", currency: "PKR", tableId })).toEqual({
      branchId,
      orderType: "dine_in",
      currency: "PKR",
      tableId,
    });
  });

  it("accepts a takeaway order with no tableId", () => {
    const branchId = randomUUID();
    expect(CreateOrderSchema.parse({ branchId, orderType: "takeaway", currency: "PKR" })).toEqual({ branchId, orderType: "takeaway", currency: "PKR" });
  });

  it("rejects a dine-in order with no tableId", () => {
    expect(() => CreateOrderSchema.parse({ branchId: randomUUID(), orderType: "dine_in", currency: "PKR" })).toThrow();
  });

  it("rejects a takeaway order with a tableId", () => {
    expect(() => CreateOrderSchema.parse({ branchId: randomUUID(), orderType: "takeaway", currency: "PKR", tableId: randomUUID() })).toThrow();
  });

  it("rejects a delivery order with a tableId", () => {
    expect(() => CreateOrderSchema.parse({ branchId: randomUUID(), orderType: "delivery", currency: "PKR", tableId: randomUUID() })).toThrow();
  });
});
