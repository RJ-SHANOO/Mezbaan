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
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;
