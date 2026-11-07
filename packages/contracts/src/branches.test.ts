import { describe, expect, it } from "vitest";
import { CreateBranchSchema, UpdateBranchSchema } from "./branches.js";

describe("CreateBranchSchema", () => {
  it("accepts a well-formed branch", () => {
    expect(CreateBranchSchema.parse({ name: "Main Branch", timezone: "Asia/Karachi" })).toEqual({
      name: "Main Branch",
      timezone: "Asia/Karachi",
    });
  });

  it("rejects an empty name or timezone", () => {
    expect(() => CreateBranchSchema.parse({ name: "", timezone: "Asia/Karachi" })).toThrow();
    expect(() => CreateBranchSchema.parse({ name: "Main", timezone: "" })).toThrow();
  });
});

describe("UpdateBranchSchema", () => {
  it("accepts a partial update", () => {
    expect(UpdateBranchSchema.parse({ status: "inactive" })).toEqual({ status: "inactive" });
  });

  it("rejects an invalid status", () => {
    expect(() => UpdateBranchSchema.parse({ status: "closed" })).toThrow();
  });
});
