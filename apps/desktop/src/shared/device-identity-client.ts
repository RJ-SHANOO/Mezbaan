import { invoke } from "@tauri-apps/api/core";

export interface DeviceIdentity {
  branchNumber: number;
  terminalNumber: number;
  /** `null` for a terminal paired before P3-05 added this field — re-pair
   * to pick it up. See device_identity.rs's own docs. */
  restaurantId: string | null;
}

/** `null` means this terminal has never completed pairing. */
export function getDeviceIdentity(): Promise<DeviceIdentity | null> {
  return invoke<DeviceIdentity | null>("get_device_identity");
}
