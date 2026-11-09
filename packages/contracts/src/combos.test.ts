import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AttachComboSlotItemSchema, CreateComboSchema, CreateComboSlotSchema, UpdateComboSlotSchema } from "./combos.js";

describe("CreateComboSchema", () => {
  it("accepts a well-formed combo", () => {
    expect(CreateComboSchema.parse({ name: "Burger Meal Deal" })).toEqual({ name: "Burger Meal Deal" });
  });

  it("rejects an empty name", () => {
    expect(() => CreateComboSchema.parse({ name: "" })).toThrow();
  });
});

describe("CreateComboSlotSchema", () => {
  it("accepts a well-formed fixed slot", () => {
    expect(CreateComboSlotSchema.parse({ name: "Side", kind: "fixed" })).toEqual({ name: "Side", kind: "fixed" });
  });

  it("accepts a well-formed choice slot with explicit min/max", () => {
    expect(CreateComboSlotSchema.parse({ name: "Drink", kind: "choice", minSelections: 1, maxSelections: 1 })).toEqual({
      name: "Drink",
      kind: "choice",
      minSelections: 1,
      maxSelections: 1,
    });
  });

  it("rejects a missing kind or maxSelections lower than minSelections", () => {
    expect(() => CreateComboSlotSchema.parse({ name: "Drink" })).toThrow();
    expect(() => CreateComboSlotSchema.parse({ name: "Drink", kind: "choice", minSelections: 2, maxSelections: 1 })).toThrow();
  });
});

describe("UpdateComboSlotSchema", () => {
  it("rejects maxSelections lower than minSelections on a partial update too", () => {
    expect(() => UpdateComboSlotSchema.parse({ minSelections: 2, maxSelections: 1 })).toThrow();
  });
});

describe("AttachComboSlotItemSchema", () => {
  it("accepts a well-formed attach request", () => {
    const productId = randomUUID();
    expect(AttachComboSlotItemSchema.parse({ productId })).toEqual({ productId });
  });

  it("rejects a non-uuid productId", () => {
    expect(() => AttachComboSlotItemSchema.parse({ productId: "not-a-uuid" })).toThrow();
  });
});
