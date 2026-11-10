import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import type { OrderType } from "./price-lists.service.js";

export interface ServiceChargeSettingRecord {
  id: string;
  rateBasisPoints: number;
  branchId: string | null;
  orderType: OrderType | null;
  isTaxable: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateServiceChargeSettingParams {
  restaurantId: string;
  actorUserId: string;
  rateBasisPoints: number;
  branchId?: string;
  orderType?: OrderType;
  isTaxable?: boolean;
}

export interface UpdateServiceChargeSettingParams {
  restaurantId: string;
  serviceChargeSettingId: string;
  actorUserId: string;
  rateBasisPoints?: number;
  branchId?: string | null;
  orderType?: OrderType | null;
  isTaxable?: boolean;
  isActive?: boolean;
}

export interface ResolveApplicableServiceChargeParams {
  restaurantId: string;
  branchId: string;
  orderType: OrderType;
}

const SERVICE_CHARGE_SETTING_NOT_FOUND = "Service charge setting not found";

/**
 * Same CRUD reference pattern as TaxRulesService, except resolveApplicable
 * picks a single most-specifically-scoped active row rather than summing —
 * a sale has exactly one service-charge line, unlike tax, which can stack
 * several named components.
 */
@Injectable()
export class ServiceChargeSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<ServiceChargeSettingRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx.select().from(schema.serviceChargeSettings).orderBy(asc(schema.serviceChargeSettings.createdAt)),
    );
  }

  async create(params: CreateServiceChargeSettingParams): Promise<ServiceChargeSettingRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.branchId !== undefined) {
        const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
        if (branchRows.length === 0) throw new NotFoundException("Branch not found");
      }

      const rows = await tx
        .insert(schema.serviceChargeSettings)
        .values({
          restaurantId: params.restaurantId,
          rateBasisPoints: params.rateBasisPoints,
          branchId: params.branchId ?? null,
          orderType: params.orderType ?? null,
          isTaxable: params.isTaxable ?? false,
        })
        .returning();
      const setting = rows[0];
      if (!setting) throw new Error("create: service charge setting insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "service_charge_setting.created",
          targetType: "service_charge_setting",
          targetId: setting.id,
          metadata: { rateBasisPoints: setting.rateBasisPoints },
        },
        tx,
      );
      return setting;
    });
  }

  async update(params: UpdateServiceChargeSettingParams): Promise<ServiceChargeSettingRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.branchId) {
        const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
        if (branchRows.length === 0) throw new NotFoundException("Branch not found");
      }

      const rows = await tx
        .update(schema.serviceChargeSettings)
        .set({
          ...(params.rateBasisPoints !== undefined && { rateBasisPoints: params.rateBasisPoints }),
          ...(params.branchId !== undefined && { branchId: params.branchId }),
          ...(params.orderType !== undefined && { orderType: params.orderType }),
          ...(params.isTaxable !== undefined && { isTaxable: params.isTaxable }),
          ...(params.isActive !== undefined && { isActive: params.isActive }),
          updatedAt: new Date(),
        })
        .where(eq(schema.serviceChargeSettings.id, params.serviceChargeSettingId))
        .returning();
      const setting = rows[0];
      if (!setting) throw new NotFoundException(SERVICE_CHARGE_SETTING_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "service_charge_setting.updated",
          targetType: "service_charge_setting",
          targetId: setting.id,
        },
        tx,
      );
      return setting;
    });
  }

  async resolveApplicable(params: ResolveApplicableServiceChargeParams): Promise<ServiceChargeSettingRecord | null> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.serviceChargeSettings)
        .where(
          and(
            eq(schema.serviceChargeSettings.isActive, true),
            or(isNull(schema.serviceChargeSettings.branchId), eq(schema.serviceChargeSettings.branchId, params.branchId)),
            or(isNull(schema.serviceChargeSettings.orderType), eq(schema.serviceChargeSettings.orderType, params.orderType)),
          ),
        );
      if (rows.length === 0) return null;

      const [best] = rows.sort((a, b) => specificity(b) - specificity(a) || b.updatedAt.getTime() - a.updatedAt.getTime());
      return best ?? null;
    });
  }
}

function specificity(row: { branchId: string | null; orderType: string | null }): number {
  return (row.branchId !== null ? 1 : 0) + (row.orderType !== null ? 1 : 0);
}
