import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { hashPassword } from "./password.js";
import { isUniqueViolation } from "./pg-error.js";

export const ONBOARDING_OPTIONS = Symbol("ONBOARDING_OPTIONS");

export interface OnboardingServiceOptions {
  /** Platform default commission rate for a brand-new restaurant, in basis points.
   * Configurable rather than hardcoded (CLAUDE.md section 6: "keep the value
   * configurable and do not guess") until P3-36 builds real plan selection. Never
   * taken from the signup request itself — rule 7 and rule 3's "server-owned, never
   * client input" both apply here. */
  defaultCommissionRateBasisPoints?: number;
}

export interface SignupParams {
  restaurantName: string;
  slug: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerDisplayName: string;
  firstBranchName: string;
  timezone: string;
}

export interface SignupResult {
  restaurantId: string;
  branchId: string;
}

const SLUG_TAKEN = "That restaurant URL is already taken";
const DEFAULT_COMMISSION_RATE_BASIS_POINTS = 500; // 5%

/**
 * Restaurant signup (P1-15): creates the tenant root, its first branch, and an Owner
 * account, all in one transaction — there's no tenant to scope a partial failure to,
 * so either the whole thing lands or none of it does. Runs privileged (no restaurant
 * exists yet to act as); see the comment on schema/restaurants.ts for why that's
 * required for the INSERT...RETURNING to even see its own row.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    @Inject(ONBOARDING_OPTIONS) private readonly options: OnboardingServiceOptions,
  ) {}

  async signup(params: SignupParams): Promise<SignupResult> {
    const passwordHash = await hashPassword(params.ownerPassword);

    return withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const roleRows = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, "owner"));
      const ownerRole = roleRows[0];
      if (!ownerRole) {
        // Only possible if the platform was never seeded (packages/db/src/seed.ts) —
        // a broken deploy, not something a signup request can trigger.
        throw new Error("signup: the 'owner' role is not seeded");
      }

      let restaurant: { id: string } | undefined;
      try {
        const restaurantRows = await tx
          .insert(schema.restaurants)
          .values({
            name: params.restaurantName,
            slug: params.slug,
            commissionRateBasisPoints: this.options.defaultCommissionRateBasisPoints ?? DEFAULT_COMMISSION_RATE_BASIS_POINTS,
          })
          .returning({ id: schema.restaurants.id });
        restaurant = restaurantRows[0];
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException(SLUG_TAKEN);
        }
        throw error;
      }
      if (!restaurant) throw new Error("signup: restaurant insert returned no row");

      const branchRows = await tx
        .insert(schema.branches)
        .values({ restaurantId: restaurant.id, name: params.firstBranchName, timezone: params.timezone })
        .returning({ id: schema.branches.id });
      const branch = branchRows[0];
      if (!branch) throw new Error("signup: branch insert returned no row");

      const ownerRows = await tx
        .insert(schema.users)
        .values({
          restaurantId: restaurant.id,
          // No branchId: an Owner has access to every branch (same convention as
          // schema/users.ts documents for the role generally).
          roleId: ownerRole.id,
          email: params.ownerEmail,
          passwordHash,
          displayName: params.ownerDisplayName,
        })
        .returning({ id: schema.users.id });
      const owner = ownerRows[0];
      if (!owner) throw new Error("signup: owner user insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: restaurant.id,
          branchId: branch.id,
          actorUserId: owner.id,
          action: "restaurant.signup",
          targetType: "restaurant",
          targetId: restaurant.id,
        },
        tx,
      );

      return { restaurantId: restaurant.id, branchId: branch.id };
    });
  }
}
