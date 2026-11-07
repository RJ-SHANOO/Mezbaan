import { ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import type { InvitableRoleKey } from "@mezbaan/contracts";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { generateOpaqueToken, hashOpaqueToken, parseOpaqueTokenRestaurantId } from "./opaque-token.js";
import { hashPassword } from "./password.js";
import { isUniqueViolation } from "./pg-error.js";

export const USER_INVITATION_OPTIONS = Symbol("USER_INVITATION_OPTIONS");

export interface UserInvitationServiceOptions {
  inviteTtlDays?: number;
}

export interface InviteUserParams {
  restaurantId: string;
  invitedByUserId: string;
  email: string;
  roleKey: InvitableRoleKey;
  branchId?: string;
}

export interface AcceptInviteParams {
  inviteToken: string;
  displayName: string;
  password: string;
}

export interface StaffUser {
  id: string;
  email: string;
  displayName: string;
  roleKey: string;
  branchId: string | null;
  status: "active" | "disabled";
}

export interface PendingInvitation {
  id: string;
  email: string;
  roleKey: string;
  branchId: string | null;
  expiresAt: Date;
}

const EMAIL_ALREADY_A_MEMBER = "That email is already a member of this restaurant";
const INVALID_INVITE_TOKEN = "Invalid or expired invitation";

/** The reference pattern (P1-17) for an invite-based signup: same bootstrap problem
 * as login/signup — accepting an invite happens before any tenant context exists,
 * so the token embeds the restaurantId exactly like a refresh/password-reset token. */
@Injectable()
export class UserInvitationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    @Inject(USER_INVITATION_OPTIONS) private readonly options: UserInvitationServiceOptions,
  ) {}

  private get inviteTtlMs(): number {
    return (this.options.inviteTtlDays ?? 7) * 24 * 60 * 60 * 1000;
  }

  async listUsers(restaurantId: string): Promise<StaffUser[]> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          roleKey: schema.roles.key,
          branchId: schema.users.branchId,
          status: schema.users.status,
        })
        .from(schema.users)
        .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id));
      return rows;
    });
  }

  async listPendingInvitations(restaurantId: string): Promise<PendingInvitation[]> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({
          id: schema.userInvitations.id,
          email: schema.userInvitations.email,
          roleKey: schema.roles.key,
          branchId: schema.userInvitations.branchId,
          expiresAt: schema.userInvitations.expiresAt,
        })
        .from(schema.userInvitations)
        .innerJoin(schema.roles, eq(schema.userInvitations.roleId, schema.roles.id))
        .where(isNull(schema.userInvitations.acceptedAt));
      return rows;
    });
  }

  async invite(params: InviteUserParams): Promise<{ inviteToken: string }> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingUser = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.restaurantId, params.restaurantId), eq(schema.users.email, params.email)));
      if (existingUser.length > 0) {
        throw new ConflictException(EMAIL_ALREADY_A_MEMBER);
      }

      const roleRows = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, params.roleKey));
      const role = roleRows[0];
      if (!role) throw new Error(`invite: role not seeded: ${params.roleKey}`);

      const inviteToken = generateOpaqueToken(params.restaurantId);
      await tx.insert(schema.userInvitations).values({
        restaurantId: params.restaurantId,
        branchId: params.branchId ?? null,
        roleId: role.id,
        email: params.email,
        tokenHash: hashOpaqueToken(inviteToken),
        invitedByUserId: params.invitedByUserId,
        expiresAt: new Date(Date.now() + this.inviteTtlMs),
      });

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: params.branchId ?? null,
          actorUserId: params.invitedByUserId,
          action: "user_invitation.sent",
          targetType: "user_invitation",
          targetId: params.email,
        },
        tx,
      );

      return { inviteToken };
    });
  }

  async acceptInvite(params: AcceptInviteParams): Promise<void> {
    const restaurantId = parseOpaqueTokenRestaurantId(params.inviteToken);
    if (!restaurantId) {
      throw new UnauthorizedException(INVALID_INVITE_TOKEN);
    }
    const tokenHash = hashOpaqueToken(params.inviteToken);

    await withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({
          id: schema.userInvitations.id,
          email: schema.userInvitations.email,
          roleId: schema.userInvitations.roleId,
          branchId: schema.userInvitations.branchId,
          expiresAt: schema.userInvitations.expiresAt,
          acceptedAt: schema.userInvitations.acceptedAt,
        })
        .from(schema.userInvitations)
        .where(and(eq(schema.userInvitations.restaurantId, restaurantId), eq(schema.userInvitations.tokenHash, tokenHash)));

      const invitation = rows[0];
      if (!invitation || invitation.acceptedAt !== null || invitation.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException(INVALID_INVITE_TOKEN);
      }

      const passwordHash = await hashPassword(params.password);
      let user: { id: string } | undefined;
      try {
        const userRows = await tx
          .insert(schema.users)
          .values({
            restaurantId,
            branchId: invitation.branchId,
            roleId: invitation.roleId,
            email: invitation.email,
            passwordHash,
            displayName: params.displayName,
          })
          .returning({ id: schema.users.id });
        user = userRows[0];
      } catch (error) {
        // Someone else accepted an invite (or signed up directly) with this exact
        // email in between this invite being sent and now — same race the users
        // table's unique index exists to catch.
        if (isUniqueViolation(error)) {
          throw new ConflictException(EMAIL_ALREADY_A_MEMBER);
        }
        throw error;
      }
      if (!user) throw new Error("acceptInvite: user insert returned no row");

      await tx.update(schema.userInvitations).set({ acceptedAt: new Date() }).where(eq(schema.userInvitations.id, invitation.id));

      await this.auditLogService.record(
        {
          restaurantId,
          branchId: invitation.branchId,
          actorUserId: user.id,
          action: "user_invitation.accepted",
          targetType: "user",
          targetId: user.id,
        },
        tx,
      );
    });
  }
}
