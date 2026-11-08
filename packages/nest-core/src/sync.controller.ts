import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { SyncBatchRequestSchema, type SyncBatchResponse } from "@mezbaan/contracts";
import { CurrentDevice, DeviceAuthGuard } from "./device-auth.guard.js";
import type { DeviceRecord } from "./device.service.js";
import { SyncService } from "./sync.service.js";
import { parseOrBadRequest } from "./validation.js";

/** Terminal-facing (mounted in api-pos), device-token authenticated like
 * DevicesTerminalController — tenant comes from the device record, not a user JWT,
 * since a background sync cycle has no logged-in user session to carry one. */
@Controller("sync")
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post("operations")
  @UseGuards(DeviceAuthGuard)
  async receiveBatch(@CurrentDevice() device: DeviceRecord, @Body() body: unknown): Promise<SyncBatchResponse> {
    const { operations } = parseOrBadRequest(SyncBatchRequestSchema, body);
    const results = await this.syncService.receiveBatch({
      restaurantId: device.restaurantId,
      branchId: device.branchId,
      deviceId: device.id,
      operations,
    });
    return { results };
  }
}
