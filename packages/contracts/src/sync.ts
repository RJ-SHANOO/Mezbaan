import { z } from "zod";

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
