import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface KitchenStationRecord {
  id: string;
  branchId: string;
  name: string;
  sortOrder: number;
  printerHost: string | null;
  printerPort: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateKitchenStationParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  name: string;
  sortOrder?: number;
  printerHost?: string;
  printerPort?: number;
}

export interface UpdateKitchenStationParams {
  restaurantId: string;
  stationId: string;
  actorUserId: string;
  name?: string;
  sortOrder?: number;
  printerHost?: string | null;
  printerPort?: number | null;
}

const STATION_NOT_FOUND = "Kitchen station not found";
const PRINTER_HOST_PORT_TOGETHER = "printerHost and printerPort must be set or cleared together";

/** P3-01: CRUD for kitchen stations, same reference pattern as FloorsService. */
@Injectable()
export class KitchenStationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, branchId?: string): Promise<KitchenStationRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.kitchenStations)
        .where(branchId !== undefined ? eq(schema.kitchenStations.branchId, branchId) : undefined)
        .orderBy(asc(schema.kitchenStations.sortOrder)),
    );
  }

  async create(params: CreateKitchenStationParams): Promise<KitchenStationRecord> {
    if ((params.printerHost !== undefined) !== (params.printerPort !== undefined)) {
      throw new BadRequestException(PRINTER_HOST_PORT_TOGETHER);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx
        .select({ id: schema.branches.id })
        .from(schema.branches)
        .where(and(eq(schema.branches.id, params.branchId), eq(schema.branches.restaurantId, params.restaurantId)));
      if (branchRows.length === 0) throw new NotFoundException("Branch not found");

      const rows = await tx
        .insert(schema.kitchenStations)
        .values({
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          name: params.name,
          sortOrder: params.sortOrder ?? 0,
          printerHost: params.printerHost ?? null,
          printerPort: params.printerPort ?? null,
        })
        .returning();
      const station = rows[0];
      if (!station) throw new Error("create: kitchen station insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "kitchen_station.created", targetType: "kitchen_station", targetId: station.id },
        tx,
      );
      return station;
    });
  }

  async update(params: UpdateKitchenStationParams): Promise<KitchenStationRecord> {
    if ((params.printerHost !== undefined) !== (params.printerPort !== undefined)) {
      throw new BadRequestException(PRINTER_HOST_PORT_TOGETHER);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.kitchenStations)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          ...(params.printerHost !== undefined && { printerHost: params.printerHost }),
          ...(params.printerPort !== undefined && { printerPort: params.printerPort }),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.kitchenStations.id, params.stationId), eq(schema.kitchenStations.restaurantId, params.restaurantId)))
        .returning();
      const station = rows[0];
      if (!station) throw new NotFoundException(STATION_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "kitchen_station.updated", targetType: "kitchen_station", targetId: station.id },
        tx,
      );
      return station;
    });
  }
}
