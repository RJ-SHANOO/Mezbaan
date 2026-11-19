import { z } from "zod";
import { OrderTypeSchema } from "./price-lists.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

// Mirrors the Rust sync client's wire shape (apps/desktop/src-tauri/src/sync_client.rs)
// — payload stays a plain string (the client's already-JSON-encoded operation data),
// not parsed here, since nothing on this generic ingestion path interprets
// operation_type-specific contents yet.
export const SyncOperationSchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(200),
  operationType: z.string().min(1).max(100),
  payload: z.string(),
  createdAt: z.string(),
});
export type SyncOperation = z.infer<typeof SyncOperationSchema>;

// Capped defensively — a terminal with far more than this many unsynced operations
// should send multiple requests, not one unbounded one.
export const SyncBatchRequestSchema = z.object({
  operations: z.array(SyncOperationSchema).min(1).max(200),
});
export type SyncBatchRequest = z.infer<typeof SyncBatchRequestSchema>;

export const SyncOperationResultSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().nullable().optional(),
});
export type SyncOperationResult = z.infer<typeof SyncOperationResultSchema>;

export const SyncBatchResponseSchema = z.object({
  results: z.array(SyncOperationResultSchema),
});
export type SyncBatchResponse = z.infer<typeof SyncBatchResponseSchema>;

/**
 * P2-45 (exit-gate hardening): the parsed shape of an `offline_sale.completed`
 * operation's `payload` string — mirrors apps/desktop/src-tauri/src/offline_sales.rs's
 * JSON object exactly (camelCase throughout, same wire convention as everywhere
 * else). `lines`/totals/tax breakdown are the terminal's own already-computed,
 * already-recorded numbers (rule 3: "it never silently changes a recorded
 * sale") — the server independently recalculates and flags any mismatch
 * afterward (reusing P2-26's existing reconciliation, triggered the same way
 * InvoicesService.generate already triggers it), rather than re-pricing here.
 */
export const OfflineSaleLineModifierPayloadSchema = z.object({
  modifierOptionId: z.string().uuid(),
  name: z.string().min(1),
  unitPriceMinor: MinorUnitsSchema,
  currency: z.string().min(1),
  priceListId: z.string().uuid().nullable(),
  priceListVersion: z.number().int().nullable(),
});
export type OfflineSaleLineModifierPayload = z.infer<typeof OfflineSaleLineModifierPayloadSchema>;

export const OfflineSaleLinePayloadSchema = z.object({
  productId: z.string().uuid(),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceMinor: MinorUnitsSchema,
  currency: z.string().min(1),
  // Unlike a modifier's (a free customization is legitimate — order_item_modifiers'
  // own columns are nullable), a sold item itself must always have been priced
  // against a real price list (order_items' own NOT NULL columns, rule 6: never
  // under-report a sale by accidentally selling something for free).
  priceListId: z.string().uuid(),
  priceListVersion: z.number().int(),
  modifiers: z.array(OfflineSaleLineModifierPayloadSchema),
});
export type OfflineSaleLinePayload = z.infer<typeof OfflineSaleLinePayloadSchema>;

export const OfflineSaleAppliedTaxRulePayloadSchema = z.object({
  name: z.string(),
  rateBasisPoints: z.number().int(),
});
export type OfflineSaleAppliedTaxRulePayload = z.infer<typeof OfflineSaleAppliedTaxRulePayloadSchema>;

export const OfflineSaleCompletedPayloadSchema = z.object({
  orderType: OrderTypeSchema,
  currency: z.string().min(1),
  lines: z.array(OfflineSaleLinePayloadSchema).min(1),
  documentNumber: z.string().min(1),
  subtotalMinor: MinorUnitsSchema,
  serviceChargeMinor: MinorUnitsSchema,
  taxMinor: MinorUnitsSchema,
  totalMinor: MinorUnitsSchema,
  pricingMode: z.enum(["inclusive", "exclusive"]),
  taxRateBasisPoints: z.number().int(),
  serviceChargeRateBasisPoints: z.number().int().nullable(),
  appliedTaxRules: z.array(OfflineSaleAppliedTaxRulePayloadSchema),
});
export type OfflineSaleCompletedPayload = z.infer<typeof OfflineSaleCompletedPayloadSchema>;
