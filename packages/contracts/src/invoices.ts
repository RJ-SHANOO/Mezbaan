import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { AppliedTaxRuleSchema } from "./tax.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

/** P2-18: which terminal is issuing this invoice — drives the document number's "T{terminal_number}" half.
 * P2-21: itemIds optionally scopes this invoice to a named subset of the order's currently-unbilled items
 * ("split by item") — omitted, it bills everything still unbilled, same as before splitting existed. */
export const GenerateInvoiceSchema = z.object({
  deviceId: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).min(1).optional(),
});
export type GenerateInvoice = z.infer<typeof GenerateInvoiceSchema>;

/** P2-21: one invoice per group — "split by item," named explicitly by the cashier rather than derived from seat numbers. */
export const SplitByItemsSchema = z.object({
  deviceId: z.string().uuid(),
  groups: z.array(z.array(z.string().uuid()).min(1)).min(1),
});
export type SplitByItems = z.infer<typeof SplitByItemsSchema>;

/** P2-21: "split by seat" — groups the order's currently-unbilled items by seatNumber; no explicit item list needed. */
export const SplitBySeatSchema = z.object({
  deviceId: z.string().uuid(),
});
export type SplitBySeat = z.infer<typeof SplitBySeatSchema>;

export const InvoiceSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  deviceId: z.string().uuid(),
  documentNumber: z.string(),
  subtotalMinor: MinorUnitsSchema,
  serviceChargeMinor: MinorUnitsSchema,
  taxMinor: MinorUnitsSchema,
  totalMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  pricingMode: z.enum(["inclusive", "exclusive"]),
  taxRateBasisPoints: z.number().int(),
  serviceChargeRateBasisPoints: z.number().int().nullable(),
  appliedTaxRules: z.array(AppliedTaxRuleSchema),
  actorUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;
