import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CreateCategorySchema,
  CreateProductSchema,
  SetProductBranchAvailabilitySchema,
  UpdateCategorySchema,
  UpdateProductSchema,
} from "./catalog.js";

describe("CreateCategorySchema", () => {
  it("accepts a well-formed category", () => {
    expect(CreateCategorySchema.parse({ name: "Burgers", sortOrder: 1 })).toEqual({ name: "Burgers", sortOrder: 1 });
  });

  it("rejects an empty name", () => {
    expect(() => CreateCategorySchema.parse({ name: "" })).toThrow();
  });
});

describe("UpdateCategorySchema", () => {
  it("accepts a partial update, including clearing imageUrl", () => {
    expect(UpdateCategorySchema.parse({ status: "inactive" })).toEqual({ status: "inactive" });
    expect(UpdateCategorySchema.parse({ imageUrl: null })).toEqual({ imageUrl: null });
  });

  it("rejects an invalid status", () => {
    expect(() => UpdateCategorySchema.parse({ status: "deleted" })).toThrow();
  });
});

describe("CreateProductSchema", () => {
  it("accepts a well-formed product", () => {
    const categoryId = randomUUID();
    expect(CreateProductSchema.parse({ categoryId, name: "Cheeseburger", sku: "BRG-001" })).toEqual({
      categoryId,
      name: "Cheeseburger",
      sku: "BRG-001",
    });
  });

  it("rejects a missing/non-uuid categoryId or an empty name", () => {
    expect(() => CreateProductSchema.parse({ categoryId: "not-a-uuid", name: "Burger" })).toThrow();
    expect(() => CreateProductSchema.parse({ categoryId: randomUUID(), name: "" })).toThrow();
  });
});

describe("UpdateProductSchema", () => {
  it("accepts clearing sku/barcode back to null", () => {
    expect(UpdateProductSchema.parse({ sku: null, barcode: null })).toEqual({ sku: null, barcode: null });
  });

  it("rejects an invalid status", () => {
    expect(() => UpdateProductSchema.parse({ status: "deleted" })).toThrow();
  });
});

describe("SetProductBranchAvailabilitySchema", () => {
  it("accepts a well-formed availability override", () => {
    const branchId = randomUUID();
    expect(SetProductBranchAvailabilitySchema.parse({ branchId, available: false })).toEqual({ branchId, available: false });
  });

  it("rejects a non-uuid branchId or a missing available flag", () => {
    expect(() => SetProductBranchAvailabilitySchema.parse({ branchId: "not-a-uuid", available: true })).toThrow();
    expect(() => SetProductBranchAvailabilitySchema.parse({ branchId: randomUUID() })).toThrow();
  });
});
