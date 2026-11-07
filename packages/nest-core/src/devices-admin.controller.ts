import { Body, Controller, Get, Param, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateDeviceSchema, DeviceSchema, type Device } from "@mezbaan/contracts";
import { DeviceService, type DeviceRecord } from "./device.service.js";
import { RequireBranchMatch, RequirePermission } from "./permission.decorator.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

const DeviceIdParamSchema = z.object({ id: z.string().uuid() });

function toDeviceResponse(device: DeviceRecord): Device {
  return DeviceSchema.parse({
    id: device.id,
    branchId: device.branchId,
    label: device.label,
    deviceType: device.deviceType,
    status: device.status,
    lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    createdAt: device.createdAt.toISOString(),
  });
}

/** Restaurant/branch-manager side (mounted in api-admin): create a device record,
 * generate a one-time pairing code for it, and revoke it remotely. The terminal
 * side (redeeming a code, presenting a device token) is DevicesTerminalController,
 * mounted in api-pos instead — pairing is admin-initiated, redemption is
 * terminal-initiated, and those are genuinely different trust boundaries. */
@Controller("devices")
export class DevicesAdminController {
  constructor(private readonly deviceService: DeviceService) {}

  @Get()
  @RequirePermission("settings.manage")
  async list(): Promise<Device[]> {
    const tenant = requireTenant();
    const devices = await this.deviceService.list(tenant.restaurantId);
    return devices.map(toDeviceResponse);
  }

  @Post()
  @RequirePermission("settings.manage")
  @RequireBranchMatch()
  async create(@Body() body: unknown): Promise<Device> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateDeviceSchema, body);
    const device = await this.deviceService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toDeviceResponse(device);
  }

  @Post(":id/pairing-code")
  @RequirePermission("settings.manage")
  async generatePairingCode(@Param() params: unknown): Promise<{ pairingCode: string; expiresAt: string }> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(DeviceIdParamSchema, params);
    const result = await this.deviceService.generatePairingCode({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      deviceId: id,
    });
    return { pairingCode: result.pairingCode, expiresAt: result.expiresAt.toISOString() };
  }

  @Post(":id/revoke")
  @RequirePermission("settings.manage")
  async revoke(@Param() params: unknown): Promise<Device> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(DeviceIdParamSchema, params);
    const device = await this.deviceService.revoke({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, deviceId: id });
    return toDeviceResponse(device);
  }
}

/** PermissionGuard already requires authentication for every route on this
 * controller (@RequirePermission implies it), so restaurantId/userId are always
 * non-null here — this just narrows the type instead of asserting it. */
function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
