import { z } from "zod";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SalesByMethodSchema = z.object({
  cash: MinorUnitsSchema,
  card: MinorUnitsSchema,
  bank_transfer: MinorUnitsSchema,
  wallet: MinorUnitsSchema,
});
export type SalesByMethod = z.infer<typeof SalesByMethodSchema>;

export const XReportSchema = z.object({
  shiftId: z.string().uuid(),
  openingFloatMinor: MinorUnitsSchema,
  asOf: z.string(),
  salesByMethod: SalesByMethodSchema,
  cashSalesMinor: MinorUnitsSchema,
  cashInMinor: MinorUnitsSchema,
  cashOutMinor: MinorUnitsSchema,
  expectedCashMinor: MinorUnitsSchema,
});
export type XReport = z.infer<typeof XReportSchema>;

export const ZReportSchema = z.object({
  shiftId: z.string().uuid(),
  openingFloatMinor: MinorUnitsSchema,
  closedAt: z.string(),
  salesByMethod: SalesByMethodSchema,
  cashSalesMinor: MinorUnitsSchema,
  cashInMinor: MinorUnitsSchema,
  cashOutMinor: MinorUnitsSchema,
  expectedCashMinor: MinorUnitsSchema,
  countedCashMinor: MinorUnitsSchema,
  overShortMinor: MinorUnitsSchema,
});
export type ZReport = z.infer<typeof ZReportSchema>;
