import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type PricingMode = "inclusive" | "exclusive";

export interface TaxSettingsRecord {
  id: string;
  branchId: string | null;
  pricingMode: PricingMode;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetTaxSettingsParams {
  restaurantId: string;
  actorUserId: string;
  branchId?: string;
  pricingMode: PricingMode;
}

const DEFAULT_PRICING_MODE: PricingMode = "exclusive";

/**
 * P2-05: whether this restaurant's (or one branch's) menu prices already
 * include tax. `set` is an upsert scoped by branchId — the same "at most one
 * default, at most one per branch" shape as tax_settings' own unique indexes
 * — so calling it twice for the same scope replaces the mode instead of
 * erroring or duplicating, consistent with how a settings value (not a
 * historical record) should behave.
 */
@Injectable()
export class TaxSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<TaxSettingsRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.taxSettings).orderBy(asc(schema.taxSettings.createdAt)));
  }

  async set(params: SetTaxSettingsParams): Promise<TaxSettingsRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.branchId !== undefined) {
        const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
        if (branchRows.length === 0) throw new NotFoundException("Branch not found");
      }

      const scopeMatch = params.branchId !== undefined ? eq(schema.taxSettings.branchId, params.branchId) : isNull(schema.taxSettings.branchId);
      const existingRows = await tx.select().from(schema.taxSettings).where(scopeMatch);
      const existing = existingRows[0];

      const rows = existing
        ? await tx
            .update(schema.taxSettings)
            .set({ pricingMode: params.pricingMode, updatedAt: new Date() })
            .where(eq(schema.taxSettings.id, existing.id))
            .returning()
        : await tx
            .insert(schema.taxSettings)
            .values({ restaurantId: params.restaurantId, branchId: params.branchId ?? null, pricingMode: params.pricingMode })
            .returning();
      const taxSettings = rows[0];
      if (!taxSettings) throw new Error("set: tax settings upsert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "tax_settings.set",
          targetType: "tax_settings",
          targetId: taxSettings.id,
          metadata: { branchId: taxSettings.branchId, pricingMode: taxSettings.pricingMode },
        },
        tx,
      );
      return taxSettings;
    });
  }

  /** Branch-specific override wins over the restaurant-wide default; absent
   * either, a restaurant that hasn't configured this yet defaults to
   * exclusive pricing (tax added on top) — the more common convention and
   * the one every other domain example/test already assumes. */
  async resolvePricingMode(restaurantId: string, branchId: string): Promise<PricingMode> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.taxSettings)
        .where(and(or(isNull(schema.taxSettings.branchId), eq(schema.taxSettings.branchId, branchId))));

      const branchRow = rows.find((row) => row.branchId === branchId);
      const defaultRow = rows.find((row) => row.branchId === null);
      return branchRow?.pricingMode ?? defaultRow?.pricingMode ?? DEFAULT_PRICING_MODE;
    });
  }
}
