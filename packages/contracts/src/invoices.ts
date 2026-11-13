import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { AppliedTaxRuleSchema } from "./tax.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

/** P2-18: which terminal is issuing this invoice — drives the document number's "T{terminal_number}" half. */
export const GenerateInvoiceSchema = z.object({
  deviceId: z.string().uuid(),
});
export type GenerateInvoice = z.infer<typeof GenerateInvoiceSchema>;

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
