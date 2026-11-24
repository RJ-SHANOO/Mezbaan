import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const RecordSupplierPaymentSchema = z.object({
  branchId: z.string().uuid(),
  amountMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  note: z.string().min(1).optional(),
});
export type RecordSupplierPayment = z.infer<typeof RecordSupplierPaymentSchema>;

export const SupplierLedgerEntrySchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  supplierId: z.string().uuid(),
  entryType: z.enum(["invoice", "payment"]),
  amountMinor: MinorUnitsSchema,
  currency: z.string(),
  supplierInvoiceId: z.string().uuid().nullable(),
  note: z.string().nullable(),
  actorUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type SupplierLedgerEntry = z.infer<typeof SupplierLedgerEntrySchema>;

export const SupplierBalanceSchema = z.object({
  balanceMinor: MinorUnitsSchema,
  currency: z.string().nullable(),
});
export type SupplierBalance = z.infer<typeof SupplierBalanceSchema>;

export const ListSupplierLedgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListSupplierLedgerQuery = z.infer<typeof ListSupplierLedgerQuerySchema>;

export const SupplierLedgerEntryPageSchema = pageResponseSchema(SupplierLedgerEntrySchema);
export type SupplierLedgerEntryPage = z.infer<typeof SupplierLedgerEntryPageSchema>;
