import { Controller, Get, UseGuards } from "@nestjs/common";
import type { SnapshotPublicKeyResponse, SyncSnapshotResponse } from "@mezbaan/contracts";
import { CurrentDevice, DeviceAuthGuard } from "./device-auth.guard.js";
import type { DeviceRecord } from "./device.service.js";
import { getSnapshotPublicKeyPem } from "./snapshot-signing.js";
import { SyncSnapshotService } from "./sync-snapshot.service.js";

/** Terminal-facing (mounted in api-pos), device-token authenticated like
 * SyncController and DevicesTerminalController — tenant comes from the device. */
@Controller("sync")
export class SyncSnapshotController {
  constructor(private readonly syncSnapshotService: SyncSnapshotService) {}

  @Get("snapshot")
  @UseGuards(DeviceAuthGuard)
  async getSnapshot(@CurrentDevice() device: DeviceRecord): Promise<SyncSnapshotResponse> {
    return this.syncSnapshotService.buildSnapshot(device.restaurantId, device.branchId);
  }

  /** No auth — it's a public key. Lets ops fetch it once (out of band from any
   * individual snapshot response) to embed in the desktop build for P1-27b to
   * verify against, rather than trusting a key delivered over the same channel
   * it's meant to authenticate. */
  @Get("public-key")
  getPublicKey(): SnapshotPublicKeyResponse {
    return { publicKeyPem: getSnapshotPublicKeyPem() };
  }
}
