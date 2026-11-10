import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface FloorRecord {
  id: string;
  branchId: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFloorParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  name: string;
  sortOrder?: number;
}

export interface UpdateFloorParams {
  restaurantId: string;
  floorId: string;
  actorUserId: string;
  name?: string;
  sortOrder?: number;
}

const FLOOR_NOT_FOUND = "Floor not found";

/** Same CRUD reference pattern as CategoriesService (P2-01). */
@Injectable()
export class FloorsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, branchId?: string): Promise<FloorRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.floors)
        .where(branchId !== undefined ? eq(schema.floors.branchId, branchId) : undefined)
        .orderBy(asc(schema.floors.sortOrder)),
    );
  }

  async create(params: CreateFloorParams): Promise<FloorRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      if (branchRows.length === 0) throw new NotFoundException("Branch not found");

      const rows = await tx
        .insert(schema.floors)
        .values({ restaurantId: params.restaurantId, branchId: params.branchId, name: params.name, sortOrder: params.sortOrder ?? 0 })
        .returning();
      const floor = rows[0];
      if (!floor) throw new Error("create: floor insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "floor.created", targetType: "floor", targetId: floor.id },
        tx,
      );
      return floor;
    });
  }

  async update(params: UpdateFloorParams): Promise<FloorRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.floors)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          updatedAt: new Date(),
        })
        .where(eq(schema.floors.id, params.floorId))
        .returning();
      const floor = rows[0];
      if (!floor) throw new NotFoundException(FLOOR_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "floor.updated", targetType: "floor", targetId: floor.id },
        tx,
      );
      return floor;
    });
  }
}
