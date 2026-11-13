import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GenerateInvoiceSchema, InvoiceSchema } from "./invoices.js";



describe("GenerateInvoiceSchema", () => {
  it("requires a deviceId", () => {
    const deviceId = randomUUID();
    expect(GenerateInvoiceSchema.parse({ deviceId })).toEqual({ deviceId });
    expect(() => GenerateInvoiceSchema.parse({})).toThrow();
  });
});

describe("InvoiceSchema", () => {
  it("accepts a well-formed invoice", () => {
    const invoice = {
      id: randomUUID(),
      orderId: randomUUID(),
      deviceId: randomUUID(),
      documentNumber: "B1-T2-000001",
      subtotalMinor: "1500",
      serviceChargeMinor: "0",
      taxMinor: "150",
      totalMinor: "1650",
      currency: "PKR",
      pricingMode: "exclusive",
      taxRateBasisPoints: 1000,
      serviceChargeRateBasisPoints: null,
      appliedTaxRules: [{ name: "GST", rateBasisPoints: 1000 }],
      actorUserId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    expect(InvoiceSchema.parse(invoice)).toEqual(invoice);
  });

  it("rejects a non-integer money string", () => {
    const invoice = {
      id: randomUUID(),
      orderId: randomUUID(),
      deviceId: randomUUID(),
      documentNumber: "B1-T2-000001",
      subtotalMinor: "15.00",
      serviceChargeMinor: "0",
      taxMinor: "150",
      totalMinor: "1650",
      currency: "PKR",
      pricingMode: "exclusive",
      taxRateBasisPoints: 1000,
      serviceChargeRateBasisPoints: null,
      appliedTaxRules: [],
      actorUserId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    expect(() => InvoiceSchema.parse(invoice)).toThrow();
  });
});
