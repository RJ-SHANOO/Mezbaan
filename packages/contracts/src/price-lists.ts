import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";

/** Shared with P2-09 ("support dine-in, takeaway and delivery orders") once
 * that task exists — defined here first since price lists need it now. */
export const OrderTypeSchema = z.enum(["dine_in", "takeaway", "delivery"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

const MINOR_UNITS_PATTERN = /^-?\d+$/;
/** bigint has no JSON representation — same decimal-string-over-the-wire
 * convention as MoneyWireSchema (money.ts), so a price list item's price
 * survives a round trip through JSON without precision loss. */
const UnitPriceMinorSchema = z.string().regex(MINOR_UNITS_PATTERN, "unitPriceMinor must be an integer string");

export const CreatePriceListSchema = z.object({
  name: z.string().min(1),
  currency: CurrencyCodeSchema,
  branchId: z.string().uuid().optional(),
  orderType: OrderTypeSchema.optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
  priority: z.number().int().optional(),
});
export type CreatePriceList = z.infer<typeof CreatePriceListSchema>;

export const UpdatePriceListSchema = z.object({
  name: z.string().min(1).optional(),
  branchId: z.string().uuid().nullable().optional(),
  orderType: OrderTypeSchema.nullable().optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
  priority: z.number().int().optional(),
});
export type UpdatePriceList = z.infer<typeof UpdatePriceListSchema>;

export const PriceListSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.number().int(),
  currency: CurrencyCodeSchema,
  branchId: z.string().uuid().nullable(),
  orderType: OrderTypeSchema.nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  priority: z.number().int(),
  status: z.enum(["draft", "published", "archived"]),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PriceList = z.infer<typeof PriceListSchema>;

export const SetPriceListItemSchema = z
  .object({
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    unitPriceMinor: UnitPriceMinorSchema,
  })
  .refine((data) => (data.productId !== undefined) !== (data.variantId !== undefined), {
    message: "exactly one of productId or variantId must be set",
    path: ["productId"],
  });
export type SetPriceListItem = z.infer<typeof SetPriceListItemSchema>;

export const PriceListItemSchema = z.object({
  id: z.string().uuid(),
  priceListId: z.string().uuid(),
  productId: z.string().uuid().nullable(),
  variantId: z.string().uuid().nullable(),
  unitPriceMinor: UnitPriceMinorSchema,
});
export type PriceListItem = z.infer<typeof PriceListItemSchema>;

export const ResolvePriceQuerySchema = z
  .object({
    branchId: z.string().uuid(),
    orderType: OrderTypeSchema,
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    at: z.string().datetime().optional(),
  })
  .refine((data) => (data.productId !== undefined) !== (data.variantId !== undefined), {
    message: "exactly one of productId or variantId must be set",
    path: ["productId"],
  });
export type ResolvePriceQuery = z.infer<typeof ResolvePriceQuerySchema>;

export const ResolvedPriceSchema = z.object({
  priceListId: z.string().uuid(),
  priceListName: z.string(),
  version: z.number().int(),
  currency: CurrencyCodeSchema,
  unitPriceMinor: UnitPriceMinorSchema,
});
export type ResolvedPrice = z.infer<typeof ResolvedPriceSchema>;
