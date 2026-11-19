import { z } from "zod";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const CreateCreditCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1).optional(),
  creditLimitMinor: MinorUnitsSchema.optional(),
  currency: z.string().min(1),
});
export type CreateCreditCustomer = z.infer<typeof CreateCreditCustomerSchema>;

export const UpdateCreditCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).nullable().optional(),
  creditLimitMinor: MinorUnitsSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCreditCustomer = z.infer<typeof UpdateCreditCustomerSchema>;

export const CreditCustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phone: z.string().nullable(),
  creditLimitMinor: MinorUnitsSchema,
  currency: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CreditCustomer = z.infer<typeof CreditCustomerSchema>;

export const CreditBalanceSchema = z.object({
  creditLimitMinor: MinorUnitsSchema,
  balanceMinor: MinorUnitsSchema,
  availableCreditMinor: MinorUnitsSchema,
});
export type CreditBalance = z.infer<typeof CreditBalanceSchema>;

export const ChargeCreditSchema = z.object({
  amountMinor: MinorUnitsSchema,
  invoiceId: z.string().uuid().optional(),
  note: z.string().min(1).optional(),
});
export type ChargeCredit = z.infer<typeof ChargeCreditSchema>;

export const RecordRepaymentSchema = z.object({
  amountMinor: MinorUnitsSchema,
  note: z.string().min(1).optional(),
});
export type RecordRepayment = z.infer<typeof RecordRepaymentSchema>;

export const CreditLedgerEntrySchema = z.object({
  id: z.string().uuid(),
  creditCustomerId: z.string().uuid(),
  entryType: z.enum(["charge", "repayment"]),
  amountMinor: MinorUnitsSchema,
  currency: z.string(),
  invoiceId: z.string().uuid().nullable(),
  note: z.string().nullable(),
  actorUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntrySchema>;

export const ListCreditLedgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListCreditLedgerQuery = z.infer<typeof ListCreditLedgerQuerySchema>;

export const CreditLedgerEntryPageSchema = pageResponseSchema(CreditLedgerEntrySchema);
export type CreditLedgerEntryPage = z.infer<typeof CreditLedgerEntryPageSchema>;
