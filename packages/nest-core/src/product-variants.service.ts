import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ProductVariantRecord {
  id: string;
  productId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  sortOrder: number;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProductVariantParams {
  restaurantId: string;
  actorUserId: string;
  productId: string;
  name: string;
  sku?: string;
  barcode?: string;
  sortOrder?: number;
}

export interface UpdateProductVariantParams {
  restaurantId: string;
  variantId: string;
  actorUserId: string;
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  sortOrder?: number;
  status?: "active" | "inactive";
}

const VARIANT_NOT_FOUND = "Product variant not found";
const PRODUCT_NOT_FOUND = "Product not found";

/** Same CRUD reference pattern as ProductsService (P2-01), including the same
 * explicit tenant-scoped existence check for productId — RLS doesn't protect
 * the FK itself, only queries run under a real tenant context. */
@Injectable()
export class ProductVariantsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, productId: string): Promise<ProductVariantRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.productVariants)
        .where(eq(schema.productVariants.productId, productId))
        .orderBy(asc(schema.productVariants.sortOrder)),
    );
  }

  async create(params: CreateProductVariantParams): Promise<ProductVariantRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const productRows = await tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, params.productId));
      if (productRows.length === 0) throw new NotFoundException(PRODUCT_NOT_FOUND);

      const rows = await tx
        .insert(schema.productVariants)
        .values({
          restaurantId: params.restaurantId,
          productId: params.productId,
          name: params.name,
          sku: params.sku ?? null,
          barcode: params.barcode ?? null,
          sortOrder: params.sortOrder ?? 0,
        })
        .returning();
      const variant = rows[0];
      if (!variant) throw new Error("create: product variant insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "product_variant.created",
          targetType: "product_variant",
          targetId: variant.id,
        },
        tx,
      );
      return variant;
    });
  }

  async update(params: UpdateProductVariantParams): Promise<ProductVariantRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.productVariants)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sku !== undefined && { sku: params.sku }),
          ...(params.barcode !== undefined && { barcode: params.barcode }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          ...(params.status !== undefined && { status: params.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.productVariants.id, params.variantId))
        .returning();
      const variant = rows[0];
      if (!variant) throw new NotFoundException(VARIANT_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "product_variant.updated",
          targetType: "product_variant",
          targetId: variant.id,
          metadata: { name: params.name, status: params.status },
        },
        tx,
      );
      return variant;
    });
  }
}
