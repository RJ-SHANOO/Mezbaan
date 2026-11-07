import { Controller, Get, Headers, Param, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { UpdateManifest } from "@mezbaan/contracts";
import { CurrentDevice, DeviceAuthGuard } from "./device-auth.guard.js";
import type { DeviceRecord } from "./device.service.js";
import { ReleasesService } from "./releases.service.js";

/**
 * The dynamic update-check endpoint Tauri's updater plugin hits, configured in
 * tauri.conf.json as `.../releases/check/{{target}}/{{arch}}/{{current_version}}`.
 * Device-token authenticated (P1-20's DeviceAuthGuard) so each check can be bucketed
 * for staged rollout by the device's own id (see ReleasesService.rolloutBucket) —
 * mounted in api-pos only, same reasoning as DevicesTerminalController.
 */
@Controller("releases")
export class ReleasesController {
  constructor(private readonly releasesService: ReleasesService) {}

  @Get("check/:target/:arch/:currentVersion")
  @UseGuards(DeviceAuthGuard)
  async check(
    @Param("target") target: string,
    @Param("arch") arch: string,
    @Param("currentVersion") currentVersion: string,
    @Headers("x-rollback-to-version") rollbackToVersion: string | undefined,
    @CurrentDevice() device: DeviceRecord,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<UpdateManifest | undefined> {
    const manifest = await this.releasesService.checkForUpdate({
      platform: `${target}-${arch}`,
      currentVersion,
      deviceId: device.id,
      rollbackToVersion,
    });

    if (!manifest) {
      // Tauri's updater convention: 204 means "no update available."
      res.status(204);
      return undefined;
    }
    return manifest;
  }
}
