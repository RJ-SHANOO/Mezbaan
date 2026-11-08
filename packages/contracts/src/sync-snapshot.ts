import { z } from "zod";

// Phase 1 scope only: staff (with PIN hashes, so P1-27b can verify offline) and
// branches (the closest thing to "settings" that exists today). menu/prices have
// no schema yet (Phase 2, P2-01/P2-04) — nothing to sync until then; this shape is
// meant to grow a `menu`/`prices` section alongside those tasks, not be redesigned.
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

export const SnapshotContentSchema = z.object({
  restaurantId: z.string().uuid(),
  branches: z.array(SnapshotBranchSchema),
  staff: z.array(SnapshotStaffMemberSchema),
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
