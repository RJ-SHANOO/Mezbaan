import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface UnitRecord {
  id: string;
  name: string;
  abbreviation: string;
  createdAt: Date;
}

export interface CreateUnitParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  abbreviation: string;
}

export interface UpdateUnitParams {
  restaurantId: string;
  unitId: string;
  actorUserId: string;
  name?: string;
  abbreviation?: string;
}

const UNIT_NOT_FOUND = "Unit not found";

/** P3-08: CRUD for restaurant-defined units of measure — same reference
 * pattern as InventoryCategoriesService (P3-07); uniqueness of
 * `abbreviation` per restaurant is enforced by the DB's own unique index
 * (units.ts), same tradeoff ProductsService/InventoryItemsService already
 * made for SKU/barcode. */
@Injectable()
export class UnitsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<UnitRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.units).orderBy(asc(schema.units.name)));
  }

  async create(params: CreateUnitParams): Promise<UnitRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.insert(schema.units).values({ restaurantId: params.restaurantId, name: params.name, abbreviation: params.abbreviation }).returning();
      const unit = rows[0];
      if (!unit) throw new Error("create: unit insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "unit.created", targetType: "unit", targetId: unit.id },
        tx,
      );
      return unit;
    });
  }

  async update(params: UpdateUnitParams): Promise<UnitRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.units)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.abbreviation !== undefined && { abbreviation: params.abbreviation }),
        })
        .where(eq(schema.units.id, params.unitId))
        .returning();
      const unit = rows[0];
      if (!unit) throw new NotFoundException(UNIT_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "unit.updated", targetType: "unit", targetId: unit.id },
        tx,
      );
      return unit;
    });
  }
}
