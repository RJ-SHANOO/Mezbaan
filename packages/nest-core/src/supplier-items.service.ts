import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { isUniqueViolation } from "./pg-error.js";

export interface SupplierItemRecord {
  id: string;
  supplierId: string;
  itemId: string;
  supplierSku: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LinkSupplierItemParams {
  restaurantId: string;
  actorUserId: string;
  supplierId: string;
  itemId: string;
  supplierSku?: string;
}

export interface UpdateSupplierItemParams {
  restaurantId: string;
  actorUserId: string;
  supplierItemId: string;
  supplierSku: string | null;
}

export interface ListSupplierItemsParams {
  restaurantId: string;
  supplierId?: string;
  itemId?: string;
}

const SUPPLIER_NOT_FOUND = "Supplier not found";
const ITEM_NOT_FOUND = "Inventory item not found";
const LINK_NOT_FOUND = "Supplier item link not found";
const ALREADY_LINKED = "this supplier is already linked to this item";

/**
 * P3-20: which inventory items a supplier supplies — see supplier-items.ts's
 * own docs for why this is a plain, hard-deletable link rather than a
 * soft-disable like SuppliersService's own status field.
 */
@Injectable()
export class SupplierItemsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(params: ListSupplierItemsParams): Promise<SupplierItemRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.supplierItems)
        .where(
          and(
            params.supplierId !== undefined ? eq(schema.supplierItems.supplierId, params.supplierId) : undefined,
            params.itemId !== undefined ? eq(schema.supplierItems.itemId, params.itemId) : undefined,
          ),
        ),
    );
  }

  async link(params: LinkSupplierItemParams): Promise<SupplierItemRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const supplierRows = await tx.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.id, params.supplierId));
      if (supplierRows.length === 0) throw new NotFoundException(SUPPLIER_NOT_FOUND);

      const itemRows = await tx.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(eq(schema.inventoryItems.id, params.itemId));
      if (itemRows.length === 0) throw new NotFoundException(ITEM_NOT_FOUND);

      let rows: Array<typeof schema.supplierItems.$inferSelect>;
      try {
        rows = await tx
          .insert(schema.supplierItems)
          .values({ restaurantId: params.restaurantId, supplierId: params.supplierId, itemId: params.itemId, supplierSku: params.supplierSku ?? null })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new BadRequestException(ALREADY_LINKED);
        throw error;
      }
      const link = rows[0];
      if (!link) throw new Error("link: supplier item insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "supplier_item.linked",
          targetType: "supplier_item",
          targetId: link.id,
          metadata: { supplierId: params.supplierId, itemId: params.itemId },
        },
        tx,
      );
      return link;
    });
  }

  async update(params: UpdateSupplierItemParams): Promise<SupplierItemRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.supplierItems)
        .set({ supplierSku: params.supplierSku, updatedAt: new Date() })
        .where(eq(schema.supplierItems.id, params.supplierItemId))
        .returning();
      const link = rows[0];
      if (!link) throw new NotFoundException(LINK_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "supplier_item.updated", targetType: "supplier_item", targetId: link.id },
        tx,
      );
      return link;
    });
  }

  async unlink(params: { restaurantId: string; actorUserId: string; supplierItemId: string }): Promise<void> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.delete(schema.supplierItems).where(eq(schema.supplierItems.id, params.supplierItemId)).returning({ id: schema.supplierItems.id });
      if (rows.length === 0) throw new NotFoundException(LINK_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "supplier_item.unlinked", targetType: "supplier_item", targetId: params.supplierItemId },
        tx,
      );
    });
  }
}
