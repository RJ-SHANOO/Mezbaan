import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { OrderTypeSchema } from "./price-lists.js";

export const OrderStatusSchema = z.enum(["open", "closed", "cancelled"]);
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
