import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface CategoryRecord {
  id: string;
  name: string;
  sortOrder: number;
  status: "active" | "inactive";
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCategoryParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  sortOrder?: number;
  imageUrl?: string;
}

export interface UpdateCategoryParams {
  restaurantId: string;
  categoryId: string;
  actorUserId: string;
  name?: string;
  sortOrder?: number;
  status?: "active" | "inactive";
  imageUrl?: string | null;
}

const CATEGORY_NOT_FOUND = "Category not found";

/** Same CRUD reference pattern as BranchesService (P1-17): every read/write
 * goes through withTenant, every mutation is audited. */
@Injectable()
export class CategoriesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<CategoryRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx.select().from(schema.categories).orderBy(asc(schema.categories.sortOrder)),
    );
  }

  async create(params: CreateCategoryParams): Promise<CategoryRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.categories)
        .values({
          restaurantId: params.restaurantId,
          name: params.name,
          sortOrder: params.sortOrder ?? 0,
          imageUrl: params.imageUrl ?? null,
        })
        .returning();
      const category = rows[0];
      if (!category) throw new Error("create: category insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "category.created",
          targetType: "category",
          targetId: category.id,
        },
        tx,
      );
      return category;
    });
  }

  async update(params: UpdateCategoryParams): Promise<CategoryRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.categories)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          ...(params.status !== undefined && { status: params.status }),
          ...(params.imageUrl !== undefined && { imageUrl: params.imageUrl }),
          updatedAt: new Date(),
        })
        .where(eq(schema.categories.id, params.categoryId))
        .returning();
      const category = rows[0];
      if (!category) throw new NotFoundException(CATEGORY_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "category.updated",
          targetType: "category",
          targetId: category.id,
          metadata: { name: params.name, status: params.status },
        },
        tx,
      );
      return category;
    });
  }
}
