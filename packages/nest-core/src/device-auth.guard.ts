import {
  createParamDecorator,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { DeviceService, type DeviceRecord } from "./device.service.js";

export const DEVICE_TOKEN_HEADER = "x-device-token";

interface DeviceAwareRequest {
  headers: Record<string, unknown>;
  device?: DeviceRecord;
}

/**
 * Deliberately a separate header from Authorization: device tokens are opaque (like
 * refresh tokens), not JWTs, and TenantContextGuard — global, runs on every route —
 * would reject them outright if presented as `Authorization: Bearer <...>`. This
 * guard is opt-in via @UseGuards on the handful of terminal-facing routes that need
 * it (api-pos's /devices/me today; future sync endpoints later).
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly deviceService: DeviceService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceAwareRequest>();
    const header = request.headers[DEVICE_TOKEN_HEADER];
    const token = typeof header === "string" ? header : undefined;
    if (!token) {
      throw new UnauthorizedException("Device token required");
    }

    request.device = await this.deviceService.validateDeviceToken(token);
    return true;
  }
}

/** Reads the device DeviceAuthGuard already validated and attached to the request —
 * only meaningful on a route that also has `@UseGuards(DeviceAuthGuard)`. */
export const CurrentDevice = createParamDecorator((_: unknown, ctx: ExecutionContext): DeviceRecord => {
  const request = ctx.switchToHttp().getRequest<DeviceAwareRequest>();
  if (!request.device) {
    throw new UnauthorizedException("Device token required");
  }
  return request.device;
});
