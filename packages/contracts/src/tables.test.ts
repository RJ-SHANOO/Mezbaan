import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CreateDiningTableSchema, CreateFloorSchema, UpdateDiningTableSchema } from "./tables.js";

describe("CreateFloorSchema", () => {
  it("accepts a well-formed floor", () => {
    const branchId = randomUUID();
    expect(CreateFloorSchema.parse({ branchId, name: "Ground Floor" })).toEqual({ branchId, name: "Ground Floor" });
  });

  it("rejects an empty name", () => {
    expect(() => CreateFloorSchema.parse({ branchId: randomUUID(), name: "" })).toThrow();
  });
});

describe("CreateDiningTableSchema", () => {
  it("accepts a well-formed table", () => {
    const floorId = randomUUID();
    expect(CreateDiningTableSchema.parse({ floorId, name: "T1", seatCount: 4 })).toEqual({ floorId, name: "T1", seatCount: 4 });
  });

  it("rejects a zero or negative seat count", () => {
    const floorId = randomUUID();
    expect(() => CreateDiningTableSchema.parse({ floorId, name: "T1", seatCount: 0 })).toThrow();
  });
});

describe("UpdateDiningTableSchema", () => {
  it("rejects an unknown status", () => {
    expect(() => UpdateDiningTableSchema.parse({ status: "on_fire" })).toThrow();
  });

  it("accepts clearing a position back to unplaced", () => {
    expect(UpdateDiningTableSchema.parse({ positionX: null, positionY: null })).toEqual({ positionX: null, positionY: null });
  });
});
