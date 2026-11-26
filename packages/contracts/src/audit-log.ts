import { z } from "zod";
import { pageResponseSchema } from "./pagination.js";

/** P3-40: `actingAsSuperAdmin` is the "clear visible notice" primitive in
 * the audit trail itself — every entry says plainly whether it was
 * platform ops acting on this restaurant's data, or the restaurant's own
 * staff. */
export const AuditLogSchema = z.object({
  id: z.string().uuid(),
  restaurantId: z.string().uuid(),
  branchId: z.string().uuid().nullable(),
  actorUserId: z.string().uuid().nullable(),
  deviceId: z.string().uuid().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  actingAsSuperAdmin: z.boolean(),
  createdAt: z.string(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

export const ListAuditLogsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuerySchema>;

export const AuditLogPageSchema = pageResponseSchema(AuditLogSchema);
export type AuditLogPage = z.infer<typeof AuditLogPageSchema>;
