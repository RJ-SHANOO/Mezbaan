import { z } from "zod";
import { OrderTypeSchema } from "./price-lists.js";

export const ListKitchenTicketsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  stationId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  includeBumped: z.coerce.boolean().optional(),
  /** Only tickets fired at or after this time — keeps an includeBumped=true
   * poll from scanning every ticket ever fired at a branch. */
  since: z.string().datetime().optional(),
});
export type ListKitchenTicketsQuery = z.infer<typeof ListKitchenTicketsQuerySchema>;

export const KitchenTicketModifierSchema = z.object({
  name: z.string(),
  quantity: z.number().int(),
});
export type KitchenTicketModifier = z.infer<typeof KitchenTicketModifierSchema>;

/** No money fields anywhere here (rule 18) — name/quantity/notes/modifiers/void status only. */
export const KitchenTicketItemSchema = z.object({
  orderItemId: z.string().uuid(),
  name: z.string(),
  quantity: z.number().int(),
  notes: z.string().nullable(),
  seatNumber: z.number().int().nullable(),
  course: z.string().nullable(),
  modifiers: z.array(KitchenTicketModifierSchema),
  voided: z.boolean(),
});
export type KitchenTicketItem = z.infer<typeof KitchenTicketItemSchema>;

export const KitchenTicketSchema = z.object({
  orderId: z.string().uuid(),
  branchId: z.string().uuid(),
  tableId: z.string().uuid().nullable(),
  orderType: OrderTypeSchema,
  stationId: z.string().uuid().nullable(),
  stationName: z.string().nullable(),
  printerHost: z.string().nullable(),
  printerPort: z.number().int().nullable(),
  rush: z.boolean(),
  firedAt: z.string(),
  firedByUserId: z.string().uuid().nullable(),
  bumped: z.boolean(),
  bumpedAt: z.string().nullable(),
  bumpedByUserId: z.string().uuid().nullable(),
  items: z.array(KitchenTicketItemSchema),
});
export type KitchenTicket = z.infer<typeof KitchenTicketSchema>;

/** firedAt/stationId are the rest of the composite ticket identity alongside
 * orderId — the client already has all three from the ticket it's acting on. */
export const BumpKitchenTicketSchema = z.object({
  orderId: z.string().uuid(),
  firedAt: z.string(),
  stationId: z.string().uuid().nullable(),
});
export type BumpKitchenTicket = z.infer<typeof BumpKitchenTicketSchema>;

export const RecallKitchenTicketSchema = BumpKitchenTicketSchema;
export type RecallKitchenTicket = z.infer<typeof RecallKitchenTicketSchema>;

export const OrderReadyStatusQuerySchema = z.object({ orderId: z.string().uuid() });
export type OrderReadyStatusQuery = z.infer<typeof OrderReadyStatusQuerySchema>;

export const OrderReadyStatusSchema = z.object({ orderId: z.string().uuid(), ready: z.boolean() });
export type OrderReadyStatus = z.infer<typeof OrderReadyStatusSchema>;
