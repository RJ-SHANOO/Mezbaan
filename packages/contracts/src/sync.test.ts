import { describe, expect, it } from "vitest";
import { OfflineSaleCompletedPayloadSchema, SyncBatchRequestSchema, SyncOperationSchema } from "./sync.js";

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

const validOfflineSalePayload = {
  orderType: "takeaway",
  currency: "PKR",
  lines: [
    {
      productId: "11111111-1111-1111-8111-111111111111",
      name: "Cheeseburger",
      quantity: 2,
      unitPriceMinor: "1500",
      currency: "PKR",
      priceListId: "22222222-2222-2222-8222-222222222222",
      priceListVersion: 1,
      modifiers: [
        {
          modifierOptionId: "33333333-3333-3333-8333-333333333333",
          name: "Extra Cheese",
          unitPriceMinor: "150",
          currency: "PKR",
          priceListId: "22222222-2222-2222-8222-222222222222",
          priceListVersion: 1,
        },
      ],
    },
  ],
  documentNumber: "B1-T2-000001",
  subtotalMinor: "3300",
  serviceChargeMinor: "0",
  taxMinor: "330",
  totalMinor: "3630",
  pricingMode: "exclusive",
  taxRateBasisPoints: 1000,
  serviceChargeRateBasisPoints: null,
  appliedTaxRules: [{ name: "VAT", rateBasisPoints: 1000 }],
};

describe("OfflineSaleCompletedPayloadSchema", () => {
  it("accepts a well-formed offline sale payload", () => {
    expect(OfflineSaleCompletedPayloadSchema.parse(validOfflineSalePayload)).toEqual(validOfflineSalePayload);
  });

  it("accepts a free/unpriced modifier (no price list), but a line itself must always be priced", () => {
    const payload = {
      ...validOfflineSalePayload,
      lines: [{ ...validOfflineSalePayload.lines[0], modifiers: [{ ...validOfflineSalePayload.lines[0]!.modifiers[0]!, priceListId: null, priceListVersion: null }] }],
    };
    expect(OfflineSaleCompletedPayloadSchema.parse(payload).lines[0]?.modifiers[0]?.priceListId).toBeNull();

    const unpricedLine = { ...validOfflineSalePayload, lines: [{ ...validOfflineSalePayload.lines[0], priceListId: null }] };
    expect(() => OfflineSaleCompletedPayloadSchema.parse(unpricedLine)).toThrow();
  });

  it("rejects an empty lines array or a non-integer money string", () => {
    expect(() => OfflineSaleCompletedPayloadSchema.parse({ ...validOfflineSalePayload, lines: [] })).toThrow();
    expect(() => OfflineSaleCompletedPayloadSchema.parse({ ...validOfflineSalePayload, totalMinor: "36.30" })).toThrow();
  });
});
