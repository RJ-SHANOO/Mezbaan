import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type PaymentMethod = "cash" | "card" | "bank_transfer" | "wallet";

export const ALL_PAYMENT_METHODS: readonly PaymentMethod[] = ["cash", "card", "bank_transfer", "wallet"];

export interface PaymentMethodSettingRecord {
  id: string;
  method: PaymentMethod;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetPaymentMethodSettingParams {
  restaurantId: string;
  actorUserId: string;
  method: PaymentMethod;
  enabled: boolean;
}

/**
 * P2-19: which payment methods a restaurant accepts. Same exclusion-list
 * convention as FeatureFlagsService — absence of a row for a method means
 * "enabled," so a restaurant that hasn't configured anything still takes
 * every method on day one; a row only needs to exist to disable one.
 */
@Injectable()
export class PaymentMethodSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Only the rows that have actually been configured (i.e. ever touched) — not every method, same as feature flags. */
  async list(restaurantId: string): Promise<PaymentMethodSettingRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.paymentMethodSettings));
  }

  async set(params: SetPaymentMethodSettingParams): Promise<PaymentMethodSettingRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.paymentMethodSettings)
        .values({ restaurantId: params.restaurantId, method: params.method, enabled: params.enabled, updatedByUserId: params.actorUserId })
        .onConflictDoUpdate({
          target: [schema.paymentMethodSettings.restaurantId, schema.paymentMethodSettings.method],
          set: { enabled: params.enabled, updatedByUserId: params.actorUserId, updatedAt: new Date() },
        })
        .returning();
      const setting = rows[0];
      if (!setting) throw new Error("set: upsert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: params.enabled ? "payment_method_settings.enabled" : "payment_method_settings.disabled",
          targetType: "payment_method_settings",
          targetId: setting.id,
          metadata: { method: params.method },
        },
        tx,
      );
      return setting as PaymentMethodSettingRecord;
    });
  }

  /** The actual enabled/disabled answer a sale has to validate against — no row for this method means enabled. */
  async isEnabled(restaurantId: string, method: PaymentMethod): Promise<boolean> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({ enabled: schema.paymentMethodSettings.enabled })
        .from(schema.paymentMethodSettings)
        .where(eq(schema.paymentMethodSettings.method, method));
      return rows[0]?.enabled ?? true;
    });
  }
}
