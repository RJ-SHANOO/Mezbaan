import { describe, expect, it } from "vitest";
import { SyncBatchRequestSchema, SyncOperationSchema } from "./sync.js";

const validOperation = {
  id: "11111111-1111-1111-8111-111111111111",
  idempotencyKey: "op-1",
  operationType: "widget.created",
  payload: '{"label":"a widget"}',
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("SyncOperationSchema", () => {
  it("accepts a well-formed operation", () => {
    expect(SyncOperationSchema.parse(validOperation)).toEqual(validOperation);
  });

  it("rejects a non-uuid id or an empty idempotency key", () => {
    expect(() => SyncOperationSchema.parse({ ...validOperation, id: "not-a-uuid" })).toThrow();
    expect(() => SyncOperationSchema.parse({ ...validOperation, idempotencyKey: "" })).toThrow();
  });
});

describe("SyncBatchRequestSchema", () => {
  it("accepts a batch of one or more operations", () => {
    expect(SyncBatchRequestSchema.parse({ operations: [validOperation] }).operations).toHaveLength(1);
  });

  it("rejects an empty batch", () => {
    expect(() => SyncBatchRequestSchema.parse({ operations: [] })).toThrow();
  });

  it("rejects a batch over the size cap", () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ ...validOperation, id: `11111111-1111-1111-8111-${String(i).padStart(12, "0")}` }));
    expect(() => SyncBatchRequestSchema.parse({ operations: tooMany })).toThrow();
  });
});
