import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface InventoryCategoryRecord {
  id: string;
  name: string;
  sortOrder: number;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInventoryCategoryParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  sortOrder?: number;
}

export interface UpdateInventoryCategoryParams {
  restaurantId: string;
  categoryId: string;
  actorUserId: string;
  name?: string;
  sortOrder?: number;
  status?: "active" | "inactive";
}

const CATEGORY_NOT_FOUND = "Inventory category not found";

/** P3-07: CRUD for inventory (raw-ingredient/stock) categories — same
 * reference pattern as CategoriesService (P2-01), a separate tree from it. */
@Injectable()
export class InventoryCategoriesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<InventoryCategoryRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.inventoryCategories).orderBy(asc(schema.inventoryCategories.sortOrder)));
  }

  async create(params: CreateInventoryCategoryParams): Promise<InventoryCategoryRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.inventoryCategories)
        .values({ restaurantId: params.restaurantId, name: params.name, sortOrder: params.sortOrder ?? 0 })
        .returning();
      const category = rows[0];
      if (!category) throw new Error("create: inventory category insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "inventory_category.created", targetType: "inventory_category", targetId: category.id },
        tx,
      );
      return category;
    });
  }

  async update(params: UpdateInventoryCategoryParams): Promise<InventoryCategoryRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.inventoryCategories)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          ...(params.status !== undefined && { status: params.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.inventoryCategories.id, params.categoryId))
        .returning();
      const category = rows[0];
      if (!category) throw new NotFoundException(CATEGORY_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "inventory_category.updated", targetType: "inventory_category", targetId: category.id },
        tx,
      );
      return category;
    });
  }
}
