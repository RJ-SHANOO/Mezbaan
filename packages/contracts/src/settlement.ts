import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SettlementStatementSchema = z.object({
  id: z.string().uuid(),
  restaurantId: z.string().uuid(),
  commissionRunId: z.string().uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  totalAmountMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  createdAt: z.string(),
});
export type SettlementStatement = z.infer<typeof SettlementStatementSchema>;

/** P3-38: "how much is still owed" — always derived, never stored, the
 * same shape as InvoiceBalanceSchema (P2-20) for the opposite direction
 * of money. */
export const SettlementBalanceSchema = z.object({
  totalAmountMinor: MinorUnitsSchema,
  paidAmountMinor: MinorUnitsSchema,
  remainingAmountMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
});
export type SettlementBalance = z.infer<typeof SettlementBalanceSchema>;

export const RecordSettlementPaymentSchema = z.object({
  amountMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  reference: z.string().min(1).max(200).optional(),
});
export type RecordSettlementPayment = z.infer<typeof RecordSettlementPaymentSchema>;

export const SettlementPaymentSchema = z.object({
  id: z.string().uuid(),
  settlementStatementId: z.string().uuid(),
  amountMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  reference: z.string().nullable(),
  recordedByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type SettlementPayment = z.infer<typeof SettlementPaymentSchema>;
