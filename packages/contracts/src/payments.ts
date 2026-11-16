import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { PaymentMethodSchema } from "./payment-method-settings.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

/** P2-19/P2-20: one tendered payment against an invoice, possibly one of
 * several that together split the bill across methods. amountMinor is only
 * the part applied to the sale — tipMinor and changeMinor (cash only) are
 * both separate (rule 6: never mix a tip or change into the sale figure).
 * tenderedMinor is cash-only: what the customer physically handed over,
 * which may exceed amountMinor — the server computes and returns the exact
 * change due, it's never the caller's job to do that math. */
export const RecordPaymentSchema = z
  .object({
    method: PaymentMethodSchema,
    amountMinor: MinorUnitsSchema,
    tipMinor: MinorUnitsSchema.optional(),
    tenderedMinor: MinorUnitsSchema.optional(),
  })
  .refine((data) => data.tenderedMinor === undefined || data.method === "cash", {
    message: "tenderedMinor is only valid for cash payments",
    path: ["tenderedMinor"],
  });
export type RecordPayment = z.infer<typeof RecordPaymentSchema>;

export const PaymentSchema = z.object({
  id: z.string().uuid(),
  invoiceId: z.string().uuid(),
  method: PaymentMethodSchema,
  amountMinor: MinorUnitsSchema,
  tipMinor: MinorUnitsSchema,
  changeMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  actorUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof PaymentSchema>;

/** P2-20: how much of an invoice is still owed — the running total a split
 * payment flow checks against before deciding the next method/amount. */
export const InvoiceBalanceSchema = z.object({
  totalMinor: MinorUnitsSchema,
  paidMinor: MinorUnitsSchema,
  remainingMinor: MinorUnitsSchema,
});
export type InvoiceBalance = z.infer<typeof InvoiceBalanceSchema>;

/** P2-21: "split into equal parts" — a suggestion only. The remaining balance
 * divided into `amountsMinor.length` shares that sum back to it exactly;
 * collecting each one is still an ordinary RecordPaymentSchema call. */
export const EqualSplitSchema = z.object({
  currency: CurrencyCodeSchema,
  amountsMinor: z.array(MinorUnitsSchema),
});
export type EqualSplit = z.infer<typeof EqualSplitSchema>;
