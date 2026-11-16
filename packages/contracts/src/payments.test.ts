import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EqualSplitSchema, InvoiceBalanceSchema, PaymentSchema, RecordPaymentSchema } from "./payments.js";

describe("RecordPaymentSchema", () => {
  it("accepts a payment with a tip, and defaults tip to absent when not given", () => {
    expect(RecordPaymentSchema.parse({ method: "card", amountMinor: "10000", tipMinor: "500" })).toEqual({
      method: "card",
      amountMinor: "10000",
      tipMinor: "500",
    });
    expect(RecordPaymentSchema.parse({ method: "cash", amountMinor: "10000" })).toEqual({ method: "cash", amountMinor: "10000" });
  });

  it("accepts tenderedMinor for cash, but rejects it for any other method", () => {
    expect(RecordPaymentSchema.parse({ method: "cash", amountMinor: "10000", tenderedMinor: "11000" })).toEqual({
      method: "cash",
      amountMinor: "10000",
      tenderedMinor: "11000",
    });
    expect(() => RecordPaymentSchema.parse({ method: "card", amountMinor: "10000", tenderedMinor: "11000" })).toThrow();
  });

  it("rejects a non-integer amount string", () => {
    expect(() => RecordPaymentSchema.parse({ method: "cash", amountMinor: "100.00" })).toThrow();
  });
});

describe("PaymentSchema", () => {
  it("accepts a well-formed payment", () => {
    const payment = {
      id: randomUUID(),
      invoiceId: randomUUID(),
      method: "bank_transfer" as const,
      amountMinor: "10000",
      tipMinor: "0",
      changeMinor: "0",
      currency: "PKR",
      actorUserId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    expect(PaymentSchema.parse(payment)).toEqual(payment);
  });
});

describe("InvoiceBalanceSchema", () => {
  it("accepts a well-formed balance", () => {
    const balance = { totalMinor: "11000", paidMinor: "4000", remainingMinor: "7000" };
    expect(InvoiceBalanceSchema.parse(balance)).toEqual(balance);
  });
});

describe("EqualSplitSchema", () => {
  it("accepts a well-formed split", () => {
    const split = { currency: "PKR", amountsMinor: ["3334", "3333", "3333"] };
    expect(EqualSplitSchema.parse(split)).toEqual(split);
  });
});
