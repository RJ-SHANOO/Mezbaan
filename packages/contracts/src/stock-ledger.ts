import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const MovementTypeSchema = z.enum(["purchase", "sale", "return", "wastage", "adjustment", "count", "production", "transfer"]);
export type MovementType = z.infer<typeof MovementTypeSchema>;

/** "transfer" is deliberately excluded — it always produces two rows
 * (source and destination, sharing a server-filled-in transferGroupId),
 * so it has its own endpoint/schema (RecordTransferSchema) rather than
 * being a movementType value a caller can pick here. */
export const SingleLocationMovementTypeSchema = MovementTypeSchema.exclude(["transfer"]);
export type SingleLocationMovementType = z.infer<typeof SingleLocationMovementTypeSchema>;

/** unitCostMinor/currency: only meaningful for an increase (quantityDelta
 * > 0) — the cost this delivery/batch carries, blended into the item's
 * weighted average at this location (P3-11). Silently ignored for a
 * decrease, which the server always values at the current average
 * instead; must be given together or not at all. */
export const RecordStockMovementSchema = z
  .object({
    storageLocationId: z.string().uuid(),
    itemId: z.string().uuid(),
    movementType: SingleLocationMovementTypeSchema,
    quantityDelta: z.number().refine((n) => n !== 0, "quantityDelta must not be zero"),
    unitCostMinor: MinorUnitsSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
    note: z.string().min(1).optional(),
  })
  .refine((data) => (data.unitCostMinor !== undefined) === (data.currency !== undefined), {
    message: "unitCostMinor and currency must be given together",
    path: ["unitCostMinor"],
  });
export type RecordStockMovement = z.infer<typeof RecordStockMovementSchema>;

export const RecordTransferSchema = z.object({
  itemId: z.string().uuid(),
  fromStorageLocationId: z.string().uuid(),
  toStorageLocationId: z.string().uuid(),
  quantity: z.number().positive(),
  note: z.string().min(1).optional(),
});
export type RecordTransfer = z.infer<typeof RecordTransferSchema>;

export const StockMovementSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  movementType: MovementTypeSchema,
  quantityDelta: z.number(),
  transferGroupId: z.string().uuid().nullable(),
  unitCostMinor: MinorUnitsSchema.nullable(),
  currency: z.string().nullable(),
  note: z.string().nullable(),
  actorUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type StockMovement = z.infer<typeof StockMovementSchema>;

export const ListStockMovementsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  storageLocationId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
  movementType: MovementTypeSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListStockMovementsQuery = z.infer<typeof ListStockMovementsQuerySchema>;

export const StockMovementPageSchema = pageResponseSchema(StockMovementSchema);
export type StockMovementPage = z.infer<typeof StockMovementPageSchema>;
