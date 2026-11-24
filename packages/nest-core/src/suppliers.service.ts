import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type SupplierStatus = "active" | "inactive";

export interface SupplierRecord {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: SupplierStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSupplierParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface UpdateSupplierParams {
  restaurantId: string;
  supplierId: string;
  actorUserId: string;
  name?: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  status?: SupplierStatus;
}

const SUPPLIER_NOT_FOUND = "Supplier not found";

/** P3-20: same CRUD reference pattern as CategoriesService (P2-01) — every
 * read/write through withTenant, every mutation audited, status is a
 * soft-disable rather than a delete. */
@Injectable()
export class SuppliersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<SupplierRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.suppliers).orderBy(asc(schema.suppliers.name)));
  }

  async get(params: { restaurantId: string; supplierId: string }): Promise<SupplierRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, params.supplierId));
      const supplier = rows[0];
      if (!supplier) throw new NotFoundException(SUPPLIER_NOT_FOUND);
      return supplier;
    });
  }

  async create(params: CreateSupplierParams): Promise<SupplierRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.suppliers)
        .values({
          restaurantId: params.restaurantId,
          name: params.name,
          contactName: params.contactName ?? null,
          phone: params.phone ?? null,
          email: params.email ?? null,
          address: params.address ?? null,
        })
        .returning();
      const supplier = rows[0];
      if (!supplier) throw new Error("create: supplier insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "supplier.created", targetType: "supplier", targetId: supplier.id, metadata: { name: supplier.name } },
        tx,
      );
      return supplier;
    });
  }

  async update(params: UpdateSupplierParams): Promise<SupplierRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.suppliers)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.contactName !== undefined && { contactName: params.contactName }),
          ...(params.phone !== undefined && { phone: params.phone }),
          ...(params.email !== undefined && { email: params.email }),
          ...(params.address !== undefined && { address: params.address }),
          ...(params.status !== undefined && { status: params.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.suppliers.id, params.supplierId))
        .returning();
      const supplier = rows[0];
      if (!supplier) throw new NotFoundException(SUPPLIER_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "supplier.updated", targetType: "supplier", targetId: supplier.id, metadata: { status: params.status } },
        tx,
      );
      return supplier;
    });
  }
}
