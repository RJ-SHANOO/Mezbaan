import { Body, Controller, Post, UnauthorizedException } from "@nestjs/common";
import { ApproveManagerPinSchema, SetManagerPinSchema, type ManagerPinApprovableAction } from "@mezbaan/contracts";
import { ManagerPinService } from "./manager-pin.service.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

// The client names the action being approved, never the permission it requires —
// the server resolves that mapping itself (see ManagerPinService's requiredPermission
// doc). Only actions that already have a real approval permission (P1-09 seed data)
// are listed; extend this when a new sensitive action gets its own permission key.
const ACTION_PERMISSIONS: Record<ManagerPinApprovableAction, string> = {
  void: "pos.void.approve",
  refund: "billing.refund.approve",
};

@Controller("manager-pin")
export class ManagerPinController {
  constructor(private readonly managerPinService: ManagerPinService) {}

  /** A user sets or replaces their own manager PIN — there's no "set someone else's
   * PIN" endpoint; that's staff management (P1-17), out of scope here. */
  @Post()
  async setPin(@Body() body: unknown): Promise<{ ok: true }> {
    const tenant = getTenantContext();
    if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
      throw new UnauthorizedException("Authentication required");
    }
    const { pin } = parseOrBadRequest(SetManagerPinSchema, body);
    await this.managerPinService.setPin({ restaurantId: tenant.restaurantId, userId: tenant.userId, pin });
    return { ok: true };
  }

  /** Called mid-flow by a sensitive action (e.g. a void) to get a manager's sign-off
   * without logging that manager into the terminal. */
  @Post("approve")
  async approve(@Body() body: unknown): Promise<{ approved: true }> {
    const tenant = getTenantContext();
    if (!tenant.authenticated || !tenant.restaurantId) {
      throw new UnauthorizedException("Authentication required");
    }
    const request = parseOrBadRequest(ApproveManagerPinSchema, body);
    return this.managerPinService.approve({
      restaurantId: tenant.restaurantId,
      branchId: tenant.branchId,
      managerUserId: request.managerUserId,
      pin: request.pin,
      action: request.action,
      requiredPermission: ACTION_PERMISSIONS[request.action],
    });
  }
}
