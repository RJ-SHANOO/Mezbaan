import { z } from "zod";
import { OrderTypeSchema } from "./price-lists.js";

// Phase 1 scope was staff (with PIN hashes, so P1-27b can verify offline) and
// branches (the closest thing to "settings" that exists today). P2-11 adds the
// `menu` section this comment used to say was still missing — see
// SnapshotMenuSchema below.
export const SnapshotStaffMemberSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string(),
  roleKey: z.string(),
  branchId: z.string().uuid().nullable(),
  status: z.enum(["active", "disabled"]),
  // Null for a user who's never set a manager PIN (P1-13) — nothing to verify
  // offline for them yet.
  pinHash: z.string().nullable(),
});
export type SnapshotStaffMember = z.infer<typeof SnapshotStaffMemberSchema>;

export const SnapshotBranchSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  timezone: z.string(),
  status: z.enum(["active", "inactive"]),
});
export type SnapshotBranch = z.infer<typeof SnapshotBranchSchema>;

/**
 * P2-11: a terminal's menu cache — scoped to the one branch the requesting
 * device is paired to (unlike branches/staff above, which stay restaurant-
 * wide). Categories/products/variants are already filtered to active status
 * and, for products, to availability at this branch (P2-01's
 * product_branch_availability exclusion list) — the terminal doesn't need
 * to re-apply either filter itself.
 *
 * `prices` is a flattened, already-resolved price per (item, orderType) —
 * computed server-side by the same PriceResolutionService (P2-04) the admin
 * preview endpoint uses, not re-derived offline. This is a deliberate choice:
 * rule 3 only requires the terminal to use "the signed, versioned price list
 * synced from the server," not to re-implement price-list resolution logic
 * in Rust. Each entry still carries which list/version produced it, so the
 * server's later reconciliation of a synced sale (rule 3) has something to
 * check against. Missing an entry for an (item, orderType) pair means
 * exactly what PriceResolutionService.resolvePrice returning null means:
 * nothing has been priced for that combination yet, not an error.
 *
 * No modifier groups/options or combos here — those are P2-12's "the cart"
 * concern, the same scope line P2-09 drew around order line items.
 */
export const SnapshotMenuCategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
});
export type SnapshotMenuCategory = z.infer<typeof SnapshotMenuCategorySchema>;

export const SnapshotMenuProductSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  imageUrl: z.string().nullable(),
  sortOrder: z.number().int(),
});
export type SnapshotMenuProduct = z.infer<typeof SnapshotMenuProductSchema>;

export const SnapshotMenuVariantSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  sortOrder: z.number().int(),
});
export type SnapshotMenuVariant = z.infer<typeof SnapshotMenuVariantSchema>;

const MINOR_UNITS_PATTERN = /^-?\d+$/;

export const SnapshotMenuPriceSchema = z
  .object({
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    orderType: OrderTypeSchema,
    unitPriceMinor: z.string().regex(MINOR_UNITS_PATTERN, "unitPriceMinor must be an integer string"),
    currency: z.string().length(3),
    priceListId: z.string().uuid(),
    priceListVersion: z.number().int(),
  })
  .refine((data) => (data.productId !== undefined) !== (data.variantId !== undefined), {
    message: "exactly one of productId or variantId must be set",
    path: ["productId"],
  });
export type SnapshotMenuPrice = z.infer<typeof SnapshotMenuPriceSchema>;

export const SnapshotMenuSchema = z.object({
  branchId: z.string().uuid(),
  categories: z.array(SnapshotMenuCategorySchema),
  products: z.array(SnapshotMenuProductSchema),
  variants: z.array(SnapshotMenuVariantSchema),
  prices: z.array(SnapshotMenuPriceSchema),
});
export type SnapshotMenu = z.infer<typeof SnapshotMenuSchema>;

export const SnapshotContentSchema = z.object({
  restaurantId: z.string().uuid(),
  branches: z.array(SnapshotBranchSchema),
  staff: z.array(SnapshotStaffMemberSchema),
  menu: SnapshotMenuSchema,
});
export type SnapshotContent = z.infer<typeof SnapshotContentSchema>;

// contentJson is the exact, already-serialized SnapshotContent — signature is
// computed over these bytes directly, never a re-encoding of the parsed object
// (see snapshot-signing.ts for why).
export const SyncSnapshotResponseSchema = z.object({
  version: z.string(),
  contentJson: z.string(),
  signature: z.string(),
});
export type SyncSnapshotResponse = z.infer<typeof SyncSnapshotResponseSchema>;

export const SnapshotPublicKeyResponseSchema = z.object({
  publicKeyPem: z.string(),
});
export type SnapshotPublicKeyResponse = z.infer<typeof SnapshotPublicKeyResponseSchema>;
