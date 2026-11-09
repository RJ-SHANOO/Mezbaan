import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ComboRecord {
  id: string;
  name: string;
  sortOrder: number;
  status: "active" | "inactive";
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateComboParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  sortOrder?: number;
  imageUrl?: string;
}

export interface UpdateComboParams {
  restaurantId: string;
  comboId: string;
  actorUserId: string;
  name?: string;
  sortOrder?: number;
  status?: "active" | "inactive";
  imageUrl?: string | null;
}

const COMBO_NOT_FOUND = "Combo not found";

/** Same CRUD reference pattern as CategoriesService (P1-17/P2-01). */
@Injectable()
export class CombosService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<ComboRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.combos).orderBy(asc(schema.combos.sortOrder)));
  }

  async create(params: CreateComboParams): Promise<ComboRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.combos)
        .values({
          restaurantId: params.restaurantId,
          name: params.name,
          sortOrder: params.sortOrder ?? 0,
          imageUrl: params.imageUrl ?? null,
        })
        .returning();
      const combo = rows[0];
      if (!combo) throw new Error("create: combo insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "combo.created", targetType: "combo", targetId: combo.id },
        tx,
      );
      return combo;
    });
  }

  async update(params: UpdateComboParams): Promise<ComboRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.combos)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          ...(params.status !== undefined && { status: params.status }),
          ...(params.imageUrl !== undefined && { imageUrl: params.imageUrl }),
          updatedAt: new Date(),
        })
        .where(eq(schema.combos.id, params.comboId))
        .returning();
      const combo = rows[0];
      if (!combo) throw new NotFoundException(COMBO_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "combo.updated",
          targetType: "combo",
          targetId: combo.id,
          metadata: { name: params.name, status: params.status },
        },
        tx,
      );
      return combo;
    });
  }
}
