import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { generateOpaqueToken } from "./opaque-token.js";

export type TableStatus = "available" | "occupied" | "reserved" | "cleaning" | "out_of_service";

export interface DiningTableRecord {
  id: string;
  branchId: string;
  floorId: string;
  name: string;
  seatCount: number;
  positionX: number | null;
  positionY: number | null;
  status: TableStatus;
  qrToken: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDiningTableParams {
  restaurantId: string;
  actorUserId: string;
  floorId: string;
  name: string;
  seatCount?: number;
  positionX?: number;
  positionY?: number;
}

export interface UpdateDiningTableParams {
  restaurantId: string;
  tableId: string;
  actorUserId: string;
  floorId?: string;
  name?: string;
  seatCount?: number;
  positionX?: number | null;
  positionY?: number | null;
  status?: TableStatus;
}

export interface RegenerateQrCodeParams {
  restaurantId: string;
  tableId: string;
  actorUserId: string;
}

const TABLE_NOT_FOUND = "Table not found";
const FLOOR_NOT_FOUND = "Floor not found";
const CANNOT_MOVE_ACROSS_BRANCHES = "a table cannot be moved to a floor in a different branch";

/**
 * P2-07: floor layout, seat count, status and the QR code record for a
 * physical dining table. `status` has no transition rules here — there's no
 * order flow yet (P2-09/P2-13) to drive it automatically, so it's a plain
 * settable field for now; order-driven transitions are those tasks' job
 * once they exist. "Status colors" (the task's own wording) is left to
 * whichever screen renders this later — nothing else in this schema stores
 * a color as data, and there's no admin/POS screen yet to need one.
 */
@Injectable()
export class DiningTablesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, branchId?: string): Promise<DiningTableRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.diningTables)
        .where(branchId !== undefined ? eq(schema.diningTables.branchId, branchId) : undefined)
        .orderBy(asc(schema.diningTables.name)),
    );
  }

  async create(params: CreateDiningTableParams): Promise<DiningTableRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const floorRows = await tx.select().from(schema.floors).where(eq(schema.floors.id, params.floorId));
      const floor = floorRows[0];
      if (!floor) throw new NotFoundException(FLOOR_NOT_FOUND);

      const rows = await tx
        .insert(schema.diningTables)
        .values({
          restaurantId: params.restaurantId,
          branchId: floor.branchId,
          floorId: params.floorId,
          name: params.name,
          seatCount: params.seatCount ?? 2,
          positionX: params.positionX ?? null,
          positionY: params.positionY ?? null,
          qrToken: generateOpaqueToken(params.restaurantId),
        })
        .returning();
      const table = rows[0];
      if (!table) throw new Error("create: dining table insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "dining_table.created",
          targetType: "dining_table",
          targetId: table.id,
          metadata: { branchId: table.branchId, floorId: table.floorId, name: table.name },
        },
        tx,
      );
      return table;
    });
  }

  async update(params: UpdateDiningTableParams): Promise<DiningTableRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.diningTables).where(eq(schema.diningTables.id, params.tableId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(TABLE_NOT_FOUND);

      let branchId: string | undefined;
      if (params.floorId !== undefined) {
        const floorRows = await tx.select().from(schema.floors).where(eq(schema.floors.id, params.floorId));
        const floor = floorRows[0];
        if (!floor) throw new NotFoundException(FLOOR_NOT_FOUND);
        if (floor.branchId !== existing.branchId) throw new BadRequestException(CANNOT_MOVE_ACROSS_BRANCHES);
        branchId = floor.branchId;
      }

      const rows = await tx
        .update(schema.diningTables)
        .set({
          ...(params.floorId !== undefined && { floorId: params.floorId, branchId }),
          ...(params.name !== undefined && { name: params.name }),
          ...(params.seatCount !== undefined && { seatCount: params.seatCount }),
          ...(params.positionX !== undefined && { positionX: params.positionX }),
          ...(params.positionY !== undefined && { positionY: params.positionY }),
          ...(params.status !== undefined && { status: params.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.diningTables.id, params.tableId))
        .returning();
      const table = rows[0];
      if (!table) throw new NotFoundException(TABLE_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "dining_table.updated",
          targetType: "dining_table",
          targetId: table.id,
          metadata: { status: params.status },
        },
        tx,
      );
      return table;
    });
  }

  async regenerateQrCode(params: RegenerateQrCodeParams): Promise<DiningTableRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.diningTables)
        .set({ qrToken: generateOpaqueToken(params.restaurantId), updatedAt: new Date() })
        .where(eq(schema.diningTables.id, params.tableId))
        .returning();
      const table = rows[0];
      if (!table) throw new NotFoundException(TABLE_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "dining_table.qr_regenerated",
          targetType: "dining_table",
          targetId: table.id,
        },
        tx,
      );
      return table;
    });
  }
}
