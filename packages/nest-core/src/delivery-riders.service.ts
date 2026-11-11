import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface DeliveryRiderRecord {
  id: string;
  branchId: string;
  name: string;
  phone: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDeliveryRiderParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  name: string;
  phone: string;
}

export interface UpdateDeliveryRiderParams {
  restaurantId: string;
  riderId: string;
  actorUserId: string;
  name?: string;
  phone?: string;
  isActive?: boolean;
}

const RIDER_NOT_FOUND = "Delivery rider not found";

/** Same CRUD reference pattern as CategoriesService — a lightweight,
 * branch-scoped directory of riders, not user accounts (see delivery-riders.ts). */
@Injectable()
export class DeliveryRidersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, branchId?: string): Promise<DeliveryRiderRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.deliveryRiders)
        .where(branchId !== undefined ? eq(schema.deliveryRiders.branchId, branchId) : undefined)
        .orderBy(asc(schema.deliveryRiders.name)),
    );
  }

  async create(params: CreateDeliveryRiderParams): Promise<DeliveryRiderRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      if (branchRows.length === 0) throw new NotFoundException("Branch not found");

      const rows = await tx
        .insert(schema.deliveryRiders)
        .values({ restaurantId: params.restaurantId, branchId: params.branchId, name: params.name, phone: params.phone })
        .returning();
      const rider = rows[0];
      if (!rider) throw new Error("create: delivery rider insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "delivery_rider.created", targetType: "delivery_rider", targetId: rider.id },
        tx,
      );
      return rider;
    });
  }

  async update(params: UpdateDeliveryRiderParams): Promise<DeliveryRiderRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.deliveryRiders)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.phone !== undefined && { phone: params.phone }),
          ...(params.isActive !== undefined && { isActive: params.isActive }),
          updatedAt: new Date(),
        })
        .where(eq(schema.deliveryRiders.id, params.riderId))
        .returning();
      const rider = rows[0];
      if (!rider) throw new NotFoundException(RIDER_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "delivery_rider.updated", targetType: "delivery_rider", targetId: rider.id },
        tx,
      );
      return rider;
    });
  }
}
