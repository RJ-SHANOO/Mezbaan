import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PageRequestSchema, pageResponseSchema } from "./pagination.js";

describe("PageRequestSchema", () => {
  it("defaults limit to 20 and leaves cursor undefined", () => {
    expect(PageRequestSchema.parse({})).toEqual({ limit: 20, cursor: undefined });
  });

  it("coerces a string limit (typical of query params)", () => {
    expect(PageRequestSchema.parse({ limit: "50" })).toEqual({ limit: 50, cursor: undefined });
  });

  it("rejects a limit outside [1, 100]", () => {
    expect(() => PageRequestSchema.parse({ limit: 0 })).toThrow();
    expect(() => PageRequestSchema.parse({ limit: 101 })).toThrow();
  });
});

describe("pageResponseSchema()", () => {
  it("validates a page of items against the given item schema", () => {
    const schema = pageResponseSchema(z.object({ id: z.string() }));
    const page = { items: [{ id: "a" }, { id: "b" }], nextCursor: "abc" };
    expect(schema.parse(page)).toEqual(page);
  });

  it("allows a null nextCursor (last page)", () => {
    const schema = pageResponseSchema(z.string());
    expect(schema.parse({ items: ["x"], nextCursor: null })).toEqual({ items: ["x"], nextCursor: null });
  });
});
