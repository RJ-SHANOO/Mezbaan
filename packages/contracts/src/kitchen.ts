import { z } from "zod";

export const ListKitchenStationsQuerySchema = z.object({ branchId: z.string().uuid().optional() });
export type ListKitchenStationsQuery = z.infer<typeof ListKitchenStationsQuerySchema>;

export const CreateKitchenStationSchema = z
  .object({
    branchId: z.string().uuid(),
    name: z.string().min(1),
    sortOrder: z.number().int().optional(),
    printerHost: z.string().min(1).optional(),
    printerPort: z.number().int().positive().optional(),
  })
  .refine((data) => (data.printerHost !== undefined) === (data.printerPort !== undefined), {
    message: "printerHost and printerPort must be set together",
    path: ["printerHost"],
  });
export type CreateKitchenStation = z.infer<typeof CreateKitchenStationSchema>;

export const UpdateKitchenStationSchema = z
  .object({
    name: z.string().min(1).optional(),
    sortOrder: z.number().int().optional(),
    printerHost: z.string().min(1).nullable().optional(),
    printerPort: z.number().int().positive().nullable().optional(),
  })
  .refine((data) => (data.printerHost !== undefined) === (data.printerPort !== undefined), {
    message: "printerHost and printerPort must be set or cleared together",
    path: ["printerHost"],
  });
export type UpdateKitchenStation = z.infer<typeof UpdateKitchenStationSchema>;

export const KitchenStationSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  printerHost: z.string().nullable(),
  printerPort: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KitchenStation = z.infer<typeof KitchenStationSchema>;

export const ListKitchenRoutingRulesQuerySchema = z.object({ branchId: z.string().uuid().optional() });
export type ListKitchenRoutingRulesQuery = z.infer<typeof ListKitchenRoutingRulesQuerySchema>;

export const CreateKitchenRoutingRuleSchema = z
  .object({
    branchId: z.string().uuid(),
    stationId: z.string().uuid(),
    categoryId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
  })
  .refine((rule) => (rule.categoryId !== undefined) !== (rule.productId !== undefined), {
    message: "exactly one of categoryId or productId must be set",
  });
export type CreateKitchenRoutingRule = z.infer<typeof CreateKitchenRoutingRuleSchema>;

export const UpdateKitchenRoutingRuleSchema = z.object({
  stationId: z.string().uuid(),
});
export type UpdateKitchenRoutingRule = z.infer<typeof UpdateKitchenRoutingRuleSchema>;

export const KitchenRoutingRuleSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  stationId: z.string().uuid(),
  categoryId: z.string().uuid().nullable(),
  productId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KitchenRoutingRule = z.infer<typeof KitchenRoutingRuleSchema>;

export const ResolveKitchenStationQuerySchema = z.object({
  branchId: z.string().uuid(),
  productId: z.string().uuid(),
});
export type ResolveKitchenStationQuery = z.infer<typeof ResolveKitchenStationQuerySchema>;

export const ResolvedKitchenStationSchema = z.object({ stationId: z.string().uuid().nullable() });
export type ResolvedKitchenStation = z.infer<typeof ResolvedKitchenStationSchema>;
