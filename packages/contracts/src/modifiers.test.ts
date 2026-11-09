import { describe, expect, it } from "vitest";
import { CreateModifierGroupSchema, CreateModifierOptionSchema, UpdateModifierGroupSchema } from "./modifiers.js";

describe("CreateModifierGroupSchema", () => {
  it("accepts a well-formed required group (min 1, max 1)", () => {
    expect(CreateModifierGroupSchema.parse({ name: "Sauce", minSelections: 1, maxSelections: 1 })).toEqual({
      name: "Sauce",
      minSelections: 1,
      maxSelections: 1,
    });
  });

  it("accepts an optional, uncapped group (no min, no max)", () => {
    expect(CreateModifierGroupSchema.parse({ name: "Toppings" })).toEqual({ name: "Toppings" });
  });

  it("rejects maxSelections lower than minSelections", () => {
    expect(() => CreateModifierGroupSchema.parse({ name: "Sauce", minSelections: 2, maxSelections: 1 })).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => CreateModifierGroupSchema.parse({ name: "" })).toThrow();
  });
});

describe("UpdateModifierGroupSchema", () => {
  it("rejects maxSelections lower than minSelections on a partial update too", () => {
    expect(() => UpdateModifierGroupSchema.parse({ minSelections: 3, maxSelections: 2 })).toThrow();
  });

  it("accepts a partial update touching only one of the pair", () => {
    expect(UpdateModifierGroupSchema.parse({ maxSelections: 5 })).toEqual({ maxSelections: 5 });
  });
});

describe("CreateModifierOptionSchema", () => {
  it("accepts a well-formed option", () => {
    expect(CreateModifierOptionSchema.parse({ name: "Extra Cheese" })).toEqual({ name: "Extra Cheese" });
  });

  it("rejects an empty name", () => {
    expect(() => CreateModifierOptionSchema.parse({ name: "" })).toThrow();
  });
});
