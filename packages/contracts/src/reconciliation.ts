import { z } from "zod";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const ListReconciliationFlagsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().min(1).optional(),
});
export type ListReconciliationFlagsQuery = z.infer<typeof ListReconciliationFlagsQuerySchema>;

export const ReconciliationFlagSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  orderId: z.string().uuid(),
  storedSubtotalMinor: MinorUnitsSchema,
  expectedSubtotalMinor: MinorUnitsSchema,
  storedServiceChargeMinor: MinorUnitsSchema,
  expectedServiceChargeMinor: MinorUnitsSchema,
  storedTaxMinor: MinorUnitsSchema,
  expectedTaxMinor: MinorUnitsSchema,
  storedTotalMinor: MinorUnitsSchema,
  expectedTotalMinor: MinorUnitsSchema,
  mismatchedFields: z.array(z.string()),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ReconciliationFlag = z.infer<typeof ReconciliationFlagSchema>;

export const ReconciliationFlagPageSchema = pageResponseSchema(ReconciliationFlagSchema);
export type ReconciliationFlagPage = z.infer<typeof ReconciliationFlagPageSchema>;
