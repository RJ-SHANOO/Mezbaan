import { z } from "zod";

export const DeviceTypeSchema = z.enum(["pos_terminal", "kitchen_display", "tablet", "other"]);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const CreateDeviceSchema = z.object({
  label: z.string().min(1),
  deviceType: DeviceTypeSchema,
  branchId: z.string().uuid(),
});
export type CreateDevice = z.infer<typeof CreateDeviceSchema>;

export const DeviceSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  label: z.string(),
  deviceType: DeviceTypeSchema,
  status: z.enum(["active", "revoked"]),
  // Sequential per branch, assigned at creation — the "T2" half of a P1-28
  // document number.
  terminalNumber: z.number().int().positive(),
  // P2-45: the "B1" half of the same document number — sequential per
  // restaurant, assigned at branch creation (branches.branchNumber). Needed
  // here (not just terminalNumber) so an offline terminal can persist both
  // halves locally and mint P1-28's document numbers without a server
  // round-trip; previously nothing synced this down at all.
  branchNumber: z.number().int().positive(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const PairingCodeResponseSchema = z.object({
  pairingCode: z.string(),
  expiresAt: z.string(),
});
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;

export const RedeemPairingCodeSchema = z.object({
  pairingCode: z.string().min(1),
});
export type RedeemPairingCode = z.infer<typeof RedeemPairingCodeSchema>;

export const DeviceTokenResponseSchema = z.object({
  deviceToken: z.string(),
  device: DeviceSchema,
});

/** P2-36: a hash, never the raw token (same "never store/transmit the raw
 * secret" convention as devices.tokenHash itself) — lets any paired device
 * in the branch (fetched once while online) verify a peer's presented raw
 * token offline, by hashing it locally and checking membership, the same
 * way manager_pin_offline.rs already verifies a PIN against a synced hash. */
export const DeviceRosterEntrySchema = z.object({
  deviceId: z.string().uuid(),
  tokenHash: z.string(),
});
export type DeviceRosterEntry = z.infer<typeof DeviceRosterEntrySchema>;
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;
