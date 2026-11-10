import { z } from "zod";

export const ListFloorsQuerySchema = z.object({ branchId: z.string().uuid().optional() });
export type ListFloorsQuery = z.infer<typeof ListFloorsQuerySchema>;

export const CreateFloorSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
});
export type CreateFloor = z.infer<typeof CreateFloorSchema>;

export const UpdateFloorSchema = z.object({
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
});
export type UpdateFloor = z.infer<typeof UpdateFloorSchema>;

export const FloorSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Floor = z.infer<typeof FloorSchema>;

export const TableStatusSchema = z.enum(["available", "occupied", "reserved", "cleaning", "out_of_service"]);
export type TableStatus = z.infer<typeof TableStatusSchema>;

export const ListDiningTablesQuerySchema = z.object({ branchId: z.string().uuid().optional() });
export type ListDiningTablesQuery = z.infer<typeof ListDiningTablesQuerySchema>;

export const CreateDiningTableSchema = z.object({
  floorId: z.string().uuid(),
  name: z.string().min(1),
  seatCount: z.number().int().positive().optional(),
  positionX: z.number().int().optional(),
  positionY: z.number().int().optional(),
});
export type CreateDiningTable = z.infer<typeof CreateDiningTableSchema>;

export const UpdateDiningTableSchema = z.object({
  floorId: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  seatCount: z.number().int().positive().optional(),
  positionX: z.number().int().nullable().optional(),
  positionY: z.number().int().nullable().optional(),
  status: TableStatusSchema.optional(),
});
export type UpdateDiningTable = z.infer<typeof UpdateDiningTableSchema>;

export const DiningTableSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  floorId: z.string().uuid(),
  name: z.string(),
  seatCount: z.number().int(),
  positionX: z.number().int().nullable(),
  positionY: z.number().int().nullable(),
  status: TableStatusSchema,
  qrToken: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DiningTable = z.infer<typeof DiningTableSchema>;
