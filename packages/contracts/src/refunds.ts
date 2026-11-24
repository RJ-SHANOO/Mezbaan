import { z } from "zod";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SetRefundReasonCodeSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
});
export type SetRefundReasonCode = z.infer<typeof SetRefundReasonCodeSchema>;

export const RefundReasonCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RefundReasonCode = z.infer<typeof RefundReasonCodeSchema>;

export const RefundBalanceSchema = z.object({
  paidMinor: MinorUnitsSchema,
  refundedMinor: MinorUnitsSchema,
  refundableMinor: MinorUnitsSchema,
});
export type RefundBalance = z.infer<typeof RefundBalanceSchema>;

export const RefundStockDispositionSchema = z.enum(["return_to_stock", "wastage"]);
export type RefundStockDisposition = z.infer<typeof RefundStockDispositionSchema>;

/** P2-24: a refund always needs manager approval — managerUserId/managerPin are required, not optional like a discount's own-authority escalation.
 * P3-18: itemIds/stockDisposition are given together or not at all — see RefundsService's own docs for why a bare amount-based refund has no stock effect. */
export const IssueRefundSchema = z
  .object({
    amountMinor: MinorUnitsSchema,
    reasonCode: z.string().min(1),
    managerUserId: z.string().uuid(),
    managerPin: z.string().min(1),
    itemIds: z.array(z.string().uuid()).min(1).optional(),
    stockDisposition: RefundStockDispositionSchema.optional(),
  })
  .refine((data) => (data.itemIds !== undefined) === (data.stockDisposition !== undefined), {
    message: "itemIds and stockDisposition must be given together, or not at all",
    path: ["stockDisposition"],
  });
export type IssueRefund = z.infer<typeof IssueRefundSchema>;

export const RefundSchema = z.object({
  id: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountMinor: MinorUnitsSchema,
  currency: z.string(),
  reasonCode: z.string(),
  actorUserId: z.string().uuid(),
  approvedByUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type Refund = z.infer<typeof RefundSchema>;
