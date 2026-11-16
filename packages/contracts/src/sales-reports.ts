import { z } from "zod";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");
const BusinessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const DailyReportQuerySchema = z.object({
  branchId: z.string().uuid(),
  businessDate: BusinessDateSchema,
});
export type DailyReportQuery = z.infer<typeof DailyReportQuerySchema>;

export const DailySalesSummarySchema = z.object({
  businessDate: BusinessDateSchema,
  currency: z.string(),
  orderCount: z.number().int(),
  subtotalMinor: MinorUnitsSchema,
  taxMinor: MinorUnitsSchema,
  serviceChargeMinor: MinorUnitsSchema,
  grossSalesMinor: MinorUnitsSchema,
});
export type DailySalesSummary = z.infer<typeof DailySalesSummarySchema>;

export const PaymentBreakdownSchema = z.object({
  businessDate: BusinessDateSchema,
  currency: z.string(),
  byMethod: z.object({
    cash: MinorUnitsSchema,
    card: MinorUnitsSchema,
    bank_transfer: MinorUnitsSchema,
    wallet: MinorUnitsSchema,
  }),
  tipsMinor: MinorUnitsSchema,
  totalMinor: MinorUnitsSchema,
});
export type PaymentBreakdown = z.infer<typeof PaymentBreakdownSchema>;

export const VoidReportEntrySchema = z.object({
  itemId: z.string().uuid(),
  orderId: z.string().uuid(),
  productId: z.string().uuid().nullable(),
  variantId: z.string().uuid().nullable(),
  quantity: z.number().int(),
  valueMinor: MinorUnitsSchema,
  reasonCode: z.string().nullable(),
  voidedByUserId: z.string().uuid(),
  voidApprovedByUserId: z.string().uuid().nullable(),
  voidedAt: z.string(),
});
export type VoidReportEntry = z.infer<typeof VoidReportEntrySchema>;

export const VoidReportSchema = z.object({
  businessDate: BusinessDateSchema,
  currency: z.string(),
  entries: z.array(VoidReportEntrySchema),
  totalValueMinor: MinorUnitsSchema,
  countByReasonCode: z.record(z.string(), z.number().int()),
});
export type VoidReport = z.infer<typeof VoidReportSchema>;

export const DiscountReportEntrySchema = z.object({
  itemId: z.string().uuid(),
  orderId: z.string().uuid(),
  discountMinor: MinorUnitsSchema,
  reasonCode: z.string().nullable(),
  approvedByUserId: z.string().uuid().nullable(),
});
export type DiscountReportEntry = z.infer<typeof DiscountReportEntrySchema>;

export const DiscountReportSchema = z.object({
  businessDate: BusinessDateSchema,
  currency: z.string(),
  entries: z.array(DiscountReportEntrySchema),
  totalDiscountMinor: MinorUnitsSchema,
  countByReasonCode: z.record(z.string(), z.number().int()),
});
export type DiscountReport = z.infer<typeof DiscountReportSchema>;

export const RefundReportEntrySchema = z.object({
  refundId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountMinor: MinorUnitsSchema,
  reasonCode: z.string(),
  approvedByUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type RefundReportEntry = z.infer<typeof RefundReportEntrySchema>;

export const RefundReportSchema = z.object({
  businessDate: BusinessDateSchema,
  currency: z.string(),
  entries: z.array(RefundReportEntrySchema),
  totalRefundedMinor: MinorUnitsSchema,
  countByReasonCode: z.record(z.string(), z.number().int()),
});
export type RefundReport = z.infer<typeof RefundReportSchema>;
