import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { OrderItemSchema } from "./order-items.js";
import { OrderTypeSchema } from "./price-lists.js";

export const OrderStatusSchema = z.enum(["open", "held", "closed", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const CreateOrderSchema = z
  .object({
    branchId: z.string().uuid(),
    orderType: OrderTypeSchema,
    currency: CurrencyCodeSchema,
    tableId: z.string().uuid().optional(),
  })
  .refine((data) => (data.orderType === "dine_in") === (data.tableId !== undefined), {
    message: "a dine-in order requires a tableId, and only a dine-in order may have one",
    path: ["tableId"],
  });
export type CreateOrder = z.infer<typeof CreateOrderSchema>;

export const ListOrdersQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  status: OrderStatusSchema.optional(),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

export const CancelOrderSchema = z.object({
  reason: z.string().min(1).optional(),
});
export type CancelOrder = z.infer<typeof CancelOrderSchema>;

export const HoldOrderSchema = z.object({
  reason: z.string().min(1).optional(),
});
export type HoldOrder = z.infer<typeof HoldOrderSchema>;

/** P2-08: move a dine-in order to a different, currently-free table. */
export const TransferOrderSchema = z.object({
  targetTableId: z.string().uuid(),
});
export type TransferOrder = z.infer<typeof TransferOrderSchema>;

/** P2-08: merge this order's items into whichever order currently occupies targetTableId. */
export const MergeOrderSchema = z.object({
  targetTableId: z.string().uuid(),
});
export type MergeOrder = z.infer<typeof MergeOrderSchema>;

/** P2-08: move the given items off this order onto a new order at a different, currently-free table. */
export const SplitOrderSchema = z.object({
  targetTableId: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).min(1),
});
export type SplitOrder = z.infer<typeof SplitOrderSchema>;

export const OrderSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  orderType: OrderTypeSchema,
  tableId: z.string().uuid().nullable(),
  status: OrderStatusSchema,
  currency: CurrencyCodeSchema,
  openedByUserId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderStatusHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  fromStatus: OrderStatusSchema.nullable(),
  toStatus: OrderStatusSchema,
  actorUserId: z.string().uuid(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type OrderStatusHistoryEntry = z.infer<typeof OrderStatusHistoryEntrySchema>;

/**
 * P2-14: a dine-in table's running tab — whichever order currently occupies
 * the table (open or held; a table is freed on close/cancel, so there's
 * never more than one), its line items, and the running total. `order` is
 * null when the table has no current order, which is a real "nothing open
 * here" state, not an error.
 */
export const OrderTabSchema = z.object({
  tableId: z.string().uuid(),
  order: OrderSchema.nullable(),
  items: z.array(OrderItemSchema),
  totalMinor: z.string().nullable(),
  currency: z.string().nullable(),
});
export type OrderTab = z.infer<typeof OrderTabSchema>;

/** P2-08: the surviving order after a merge, plus the id of the order that was cancelled into it. */
export const MergeOrderResultSchema = z.object({
  targetOrder: OrderSchema,
  sourceOrderId: z.string().uuid(),
});
export type MergeOrderResult = z.infer<typeof MergeOrderResultSchema>;

/** P2-08: the original order (now short the moved items) and the new order they were split onto. */
export const SplitOrderResultSchema = z.object({
  sourceOrder: OrderSchema,
  newOrder: OrderSchema,
});
export type SplitOrderResult = z.infer<typeof SplitOrderResultSchema>;
