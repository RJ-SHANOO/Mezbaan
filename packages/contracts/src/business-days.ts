import { z } from "zod";
import { pageResponseSchema } from "./pagination.js";

export const BusinessDayStatusSchema = z.enum(["open", "closed"]);
export type BusinessDayStatus = z.infer<typeof BusinessDayStatusSchema>;

const BusinessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const CloseBusinessDaySchema = z.object({
  branchId: z.string().uuid(),
  businessDate: BusinessDateSchema.optional(),
});
export type CloseBusinessDay = z.infer<typeof CloseBusinessDaySchema>;

export const BusinessDaySchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  businessDate: BusinessDateSchema,
  status: BusinessDayStatusSchema,
  closedByUserId: z.string().uuid().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BusinessDay = z.infer<typeof BusinessDaySchema>;

export const BusinessDayStatusQuerySchema = z.object({
  branchId: z.string().uuid(),
  businessDate: BusinessDateSchema.optional(),
});
export type BusinessDayStatusQuery = z.infer<typeof BusinessDayStatusQuerySchema>;

export const BusinessDayStatusResponseSchema = z.object({
  businessDate: BusinessDateSchema,
  status: BusinessDayStatusSchema,
});
export type BusinessDayStatusResponse = z.infer<typeof BusinessDayStatusResponseSchema>;

export const ListBusinessDaysQuerySchema = z.object({
  branchId: z.string().uuid(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListBusinessDaysQuery = z.infer<typeof ListBusinessDaysQuerySchema>;

export const BusinessDayPageSchema = pageResponseSchema(BusinessDaySchema);
export type BusinessDayPage = z.infer<typeof BusinessDayPageSchema>;
