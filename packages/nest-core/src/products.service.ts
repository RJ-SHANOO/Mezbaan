import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ProductRecord {
  id: string;
  categoryId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  sortOrder: number;
  status: "active" | "inactive";
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProductParams {
  restaurantId: string;
  actorUserId: string;
  categoryId: string;
  name: string;
  sku?: string;
  barcode?: string;
  sortOrder?: number;
  imageUrl?: string;
}

export interface UpdateProductParams {
  restaurantId: string;
  productId: string;
  actorUserId: string;
  categoryId?: string;
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  sortOrder?: number;
  status?: "active" | "inactive";
  imageUrl?: string | null;
}

export interface ProductBranchAvailabilityRecord {
  branchId: string;
  available: boolean;
}

export interface SetProductBranchAvailabilityParams {
  restaurantId: string;
  actorUserId: string;
  productId: string;
  branchId: string;
  available: boolean;
}

export interface ProductModifierGroupRecord {
  modifierGroupId: string;
  sortOrder: number;
}

export interface AttachModifierGroupParams {
  restaurantId: string;
  actorUserId: string;
  productId: string;
  modifierGroupId: string;
  sortOrder?: number;
}

export interface DetachModifierGroupParams {
  restaurantId: string;
  actorUserId: string;
  productId: string;
  modifierGroupId: string;
}

const PRODUCT_NOT_FOUND = "Product not found";
const CATEGORY_NOT_FOUND = "Category not found";
const BRANCH_NOT_FOUND = "Branch not found";
const MODIFIER_GROUP_NOT_FOUND = "Modifier group not found";

/**
 * Same CRUD reference pattern as BranchesService (P1-17). One extra concern
 * products have that branches don't: categoryId (and branchId, for branch
 * availability) are foreign keys into *another* tenant table — Postgres FK
 * constraints are enforced by the migration owner, which bypasses RLS entirely
 * (table owners always bypass RLS), so the FK alone would happily accept
 * another restaurant's category or branch id. The explicit existence checks
 * below (querying under this same tenant's withTenant context, where RLS
 * really does apply) are the actual second barrier rule 2 requires here —
 * without them a product could silently point at a category it has no
 * business referencing.
 */
@Injectable()
export class ProductsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, categoryId?: string): Promise<ProductRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => {
      const query = tx.select().from(schema.products).orderBy(asc(schema.products.sortOrder));
      return categoryId ? query.where(eq(schema.products.categoryId, categoryId)) : query;
    });
  }

  async create(params: CreateProductParams): Promise<ProductRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const categoryRows = await tx.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.id, params.categoryId));
      assertFound(categoryRows.length > 0, CATEGORY_NOT_FOUND);

      const rows = await tx
        .insert(schema.products)
        .values({
          restaurantId: params.restaurantId,
          categoryId: params.categoryId,
          name: params.name,
          sku: params.sku ?? null,
          barcode: params.barcode ?? null,
          sortOrder: params.sortOrder ?? 0,
          imageUrl: params.imageUrl ?? null,
        })
        .returning();
      const product = rows[0];
      if (!product) throw new Error("create: product insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "product.created",
          targetType: "product",
          targetId: product.id,
        },
        tx,
      );
      return product;
    });
  }

  async update(params: UpdateProductParams): Promise<ProductRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.categoryId !== undefined) {
        const categoryRows = await tx.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.id, params.categoryId));
        assertFound(categoryRows.length > 0, CATEGORY_NOT_FOUND);
      }

      const rows = await tx
        .update(schema.products)
        .set({
          ...(params.categoryId !== undefined && { categoryId: params.categoryId }),
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sku !== undefined && { sku: params.sku }),
          ...(params.barcode !== undefined && { barcode: params.barcode }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          ...(params.status !== undefined && { status: params.status }),
          ...(params.imageUrl !== undefined && { imageUrl: params.imageUrl }),
          updatedAt: new Date(),
        })
        .where(eq(schema.products.id, params.productId))
        .returning();
      const product = rows[0];
      if (!product) throw new NotFoundException(PRODUCT_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "product.updated",
          targetType: "product",
          targetId: product.id,
          metadata: { name: params.name, status: params.status },
        },
        tx,
      );
      return product;
    });
  }

  /** Upserts an explicit per-branch override. Absence of a row means "available"
   * (the schema's exclusion-list convention) — this is only ever called to
   * record a deliberate exception, never to establish the default. */
  async setBranchAvailability(params: SetProductBranchAvailabilityParams): Promise<void> {
    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const productRows = await tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, params.productId));
      assertFound(productRows.length > 0, PRODUCT_NOT_FOUND);
      const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      assertFound(branchRows.length > 0, BRANCH_NOT_FOUND);

      await tx
        .insert(schema.productBranchAvailability)
        .values({
          restaurantId: params.restaurantId,
          productId: params.productId,
          branchId: params.branchId,
          available: params.available,
        })
        .onConflictDoUpdate({
          target: [schema.productBranchAvailability.productId, schema.productBranchAvailability.branchId],
          set: { available: params.available, updatedAt: new Date() },
        });

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          actorUserId: params.actorUserId,
          action: params.available ? "product.branch_availability.enabled" : "product.branch_availability.disabled",
          targetType: "product",
          targetId: params.productId,
        },
        tx,
      );
    });
  }

  /** Only the explicit overrides — a product with no row here is available at
   * every branch (the default), so an empty result means "available
   * everywhere," not "available nowhere." */
  async listBranchAvailability(restaurantId: string, productId: string): Promise<ProductBranchAvailabilityRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select({ branchId: schema.productBranchAvailability.branchId, available: schema.productBranchAvailability.available })
        .from(schema.productBranchAvailability)
        .where(eq(schema.productBranchAvailability.productId, productId)),
    );
  }

  /** P2-02: idempotent — attaching a group that's already attached just
   * updates its sortOrder rather than erroring, since there's no meaningful
   * "duplicate attachment" to reject. */
  async attachModifierGroup(params: AttachModifierGroupParams): Promise<void> {
    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const productRows = await tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, params.productId));
      assertFound(productRows.length > 0, PRODUCT_NOT_FOUND);
      const groupRows = await tx
        .select({ id: schema.modifierGroups.id })
        .from(schema.modifierGroups)
        .where(eq(schema.modifierGroups.id, params.modifierGroupId));
      assertFound(groupRows.length > 0, MODIFIER_GROUP_NOT_FOUND);

      await tx
        .insert(schema.productModifierGroups)
        .values({
          restaurantId: params.restaurantId,
          productId: params.productId,
          modifierGroupId: params.modifierGroupId,
          sortOrder: params.sortOrder ?? 0,
        })
        .onConflictDoUpdate({
          target: [schema.productModifierGroups.productId, schema.productModifierGroups.modifierGroupId],
          set: { sortOrder: params.sortOrder ?? 0 },
        });

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "product.modifier_group.attached",
          targetType: "product",
          targetId: params.productId,
          metadata: { modifierGroupId: params.modifierGroupId },
        },
        tx,
      );
    });
  }

  async detachModifierGroup(params: DetachModifierGroupParams): Promise<void> {
    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await tx
        .delete(schema.productModifierGroups)
        .where(
          and(
            eq(schema.productModifierGroups.productId, params.productId),
            eq(schema.productModifierGroups.modifierGroupId, params.modifierGroupId),
          ),
        );

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "product.modifier_group.detached",
          targetType: "product",
          targetId: params.productId,
          metadata: { modifierGroupId: params.modifierGroupId },
        },
        tx,
      );
    });
  }

  async listModifierGroups(restaurantId: string, productId: string): Promise<ProductModifierGroupRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select({ modifierGroupId: schema.productModifierGroups.modifierGroupId, sortOrder: schema.productModifierGroups.sortOrder })
        .from(schema.productModifierGroups)
        .where(eq(schema.productModifierGroups.productId, productId))
        .orderBy(asc(schema.productModifierGroups.sortOrder)),
    );
  }
}

function assertFound(exists: boolean, notFoundMessage: string): void {
  if (!exists) throw new NotFoundException(notFoundMessage);
}
