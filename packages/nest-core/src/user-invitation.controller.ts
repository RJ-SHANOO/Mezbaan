import { Body, Controller, Get, Post, UnauthorizedException } from "@nestjs/common";
import { AcceptInviteSchema, InviteUserSchema, type PendingInvitation, type User } from "@mezbaan/contracts";
import { RequirePermission } from "./permission.decorator.js";
import { getTenantContext } from "./tenant-context.js";
import { UserInvitationService } from "./user-invitation.service.js";
import { parseOrBadRequest } from "./validation.js";

@Controller("users")
export class UserInvitationController {
  constructor(private readonly userInvitationService: UserInvitationService) {}

  @Get()
  @RequirePermission("settings.manage")
  async list(): Promise<User[]> {
    const tenant = requireTenant();
    return this.userInvitationService.listUsers(tenant.restaurantId);
  }

  @Get("invitations")
  @RequirePermission("settings.manage")
  async listPendingInvitations(): Promise<PendingInvitation[]> {
    const tenant = requireTenant();
    const invitations = await this.userInvitationService.listPendingInvitations(tenant.restaurantId);
    return invitations.map((invitation) => ({ ...invitation, expiresAt: invitation.expiresAt.toISOString() }));
  }

  @Post("invite")
  @RequirePermission("settings.manage")
  async invite(@Body() body: unknown): Promise<{ inviteToken: string }> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(InviteUserSchema, body);
    return this.userInvitationService.invite({ ...request, restaurantId: tenant.restaurantId, invitedByUserId: tenant.userId });
  }

  /** Anonymous route — the invitee has no account yet, so there's no token to carry a
   * tenant context (same bootstrap problem as /onboarding/signup). */
  @Post("invite/accept")
  async acceptInvite(@Body() body: unknown): Promise<{ ok: true }> {
    const request = parseOrBadRequest(AcceptInviteSchema, body);
    await this.userInvitationService.acceptInvite(request);
    return { ok: true };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
