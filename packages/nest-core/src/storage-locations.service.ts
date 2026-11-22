import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface StorageLocationRecord {
  id: string;
  branchId: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStorageLocationParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  name: string;
  sortOrder?: number;
}

export interface UpdateStorageLocationParams {
  restaurantId: string;
  locationId: string;
  actorUserId: string;
  name?: string;
  sortOrder?: number;
}

const LOCATION_NOT_FOUND = "Storage location not found";

/** P3-07: CRUD for storage locations — same reference pattern as
 * FloorsService (P2-07) and KitchenStationsService (P3-01), both of which
 * are the same "named physical place within one branch" shape. */
@Injectable()
export class StorageLocationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, branchId?: string): Promise<StorageLocationRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.storageLocations)
        .where(branchId !== undefined ? eq(schema.storageLocations.branchId, branchId) : undefined)
        .orderBy(asc(schema.storageLocations.sortOrder)),
    );
  }

  async create(params: CreateStorageLocationParams): Promise<StorageLocationRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      if (branchRows.length === 0) throw new NotFoundException("Branch not found");

      const rows = await tx
        .insert(schema.storageLocations)
        .values({ restaurantId: params.restaurantId, branchId: params.branchId, name: params.name, sortOrder: params.sortOrder ?? 0 })
        .returning();
      const location = rows[0];
      if (!location) throw new Error("create: storage location insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "storage_location.created", targetType: "storage_location", targetId: location.id },
        tx,
      );
      return location;
    });
  }

  async update(params: UpdateStorageLocationParams): Promise<StorageLocationRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.storageLocations)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          updatedAt: new Date(),
        })
        .where(eq(schema.storageLocations.id, params.locationId))
        .returning();
      const location = rows[0];
      if (!location) throw new NotFoundException(LOCATION_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "storage_location.updated", targetType: "storage_location", targetId: location.id },
        tx,
      );
      return location;
    });
  }
}
