import { Inject, Injectable } from "@nestjs/common";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface FeatureFlagRecord {
  id: string;
  restaurantId: string;
  moduleKey: string;
  enabled: boolean;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetFeatureFlagParams {
  restaurantId: string;
  moduleKey: string;
  enabled: boolean;
  actorUserId: string;
}

/**
 * Writes are super-admin-only at the RLS level (feature-flags.ts) — every write here
 * runs with isSuperAdmin: true, consistent with that, and is gated for real by the
 * controller only ever calling it from a route that required a super-admin session.
 * Reads split in two: a restaurant's own members read their own flags under their
 * normal tenant context; a super-admin reading another restaurant's flags needs the
 * same isSuperAdmin flag reads use elsewhere (restaurants.ts, devices).
 */
@Injectable()
export class FeatureFlagsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async listForRestaurant(restaurantId: string): Promise<FeatureFlagRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.featureFlags));
  }

  async listForRestaurantAsSuperAdmin(restaurantId: string): Promise<FeatureFlagRecord[]> {
    return withTenant(this.db, { restaurantId, isSuperAdmin: true }, (tx) => tx.select().from(schema.featureFlags));
  }

  async setFlag(params: SetFeatureFlagParams): Promise<FeatureFlagRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId, isSuperAdmin: true }, async (tx) => {
      const rows = await tx
        .insert(schema.featureFlags)
        .values({
          restaurantId: params.restaurantId,
          moduleKey: params.moduleKey,
          enabled: params.enabled,
          updatedByUserId: params.actorUserId,
        })
        .onConflictDoUpdate({
          target: [schema.featureFlags.restaurantId, schema.featureFlags.moduleKey],
          set: { enabled: params.enabled, updatedByUserId: params.actorUserId, updatedAt: new Date() },
        })
        .returning();
      const flag = rows[0];
      if (!flag) throw new Error("setFlag: upsert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: params.enabled ? "feature_flag.enabled" : "feature_flag.disabled",
          targetType: "feature_flag",
          targetId: flag.id,
          metadata: { moduleKey: params.moduleKey },
        },
        tx,
      );
      return flag;
    });
  }
}
