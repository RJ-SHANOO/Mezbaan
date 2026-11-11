import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type DeliveryStatus = "pending" | "assigned" | "out_for_delivery" | "delivered" | "failed";

export interface DeliveryDetailsRecord {
  id: string;
  orderId: string;
  customerName: string;
  customerPhone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  deliveryInstructions: string | null;
  riderId: string | null;
  deliveryStatus: DeliveryStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetDeliveryDetailsParams {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  customerName: string;
  customerPhone: string;
  addressLine1: string;
  addressLine2?: string;
  city?: string;
  deliveryInstructions?: string;
}

export interface AssignRiderParams {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  riderId: string;
}

export interface UpdateDeliveryStatusParams {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  status: DeliveryStatus;
}

const ORDER_NOT_FOUND = "Order not found";
const NOT_A_DELIVERY_ORDER = "this order is not a delivery order";
const DETAILS_NOT_FOUND = "This order has no delivery details yet";
const RIDER_NOT_FOUND = "Delivery rider not found";

/**
 * P2-10: customer, address, rider and status tracking for one delivery
 * order (see delivery-details.ts for why this isn't a reusable customer
 * profile). Every method starts by confirming the referenced order
 * actually is a delivery order — the cross-table half of the invariant
 * orders.ts's CHECK constraint can't express on its own.
 */
@Injectable()
export class DeliveryDetailsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async get(restaurantId: string, orderId: string): Promise<DeliveryDetailsRecord | null> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.deliveryDetails).where(eq(schema.deliveryDetails.orderId, orderId));
      return rows[0] ?? null;
    });
  }

  async setDetails(params: SetDeliveryDetailsParams): Promise<DeliveryDetailsRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await assertDeliveryOrder(tx, params.orderId);

      const existingRows = await tx.select().from(schema.deliveryDetails).where(eq(schema.deliveryDetails.orderId, params.orderId));
      const existing = existingRows[0];

      const rows = existing
        ? await tx
            .update(schema.deliveryDetails)
            .set({
              customerName: params.customerName,
              customerPhone: params.customerPhone,
              addressLine1: params.addressLine1,
              addressLine2: params.addressLine2 ?? null,
              city: params.city ?? null,
              deliveryInstructions: params.deliveryInstructions ?? null,
              updatedAt: new Date(),
            })
            .where(eq(schema.deliveryDetails.id, existing.id))
            .returning()
        : await tx
            .insert(schema.deliveryDetails)
            .values({
              restaurantId: params.restaurantId,
              orderId: params.orderId,
              customerName: params.customerName,
              customerPhone: params.customerPhone,
              addressLine1: params.addressLine1,
              addressLine2: params.addressLine2 ?? null,
              city: params.city ?? null,
              deliveryInstructions: params.deliveryInstructions ?? null,
            })
            .returning();
      const details = rows[0];
      if (!details) throw new Error("setDetails: delivery details upsert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: existing ? "delivery_details.updated" : "delivery_details.set",
          targetType: "delivery_details",
          targetId: details.id,
          metadata: { orderId: params.orderId },
        },
        tx,
      );
      return details;
    });
  }

  async assignRider(params: AssignRiderParams): Promise<DeliveryDetailsRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await assertDeliveryOrder(tx, params.orderId);

      const riderRows = await tx.select({ id: schema.deliveryRiders.id }).from(schema.deliveryRiders).where(eq(schema.deliveryRiders.id, params.riderId));
      if (riderRows.length === 0) throw new NotFoundException(RIDER_NOT_FOUND);

      const existingRows = await tx.select().from(schema.deliveryDetails).where(eq(schema.deliveryDetails.orderId, params.orderId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(DETAILS_NOT_FOUND);

      const rows = await tx
        .update(schema.deliveryDetails)
        .set({
          riderId: params.riderId,
          deliveryStatus: existing.deliveryStatus === "pending" ? "assigned" : existing.deliveryStatus,
          updatedAt: new Date(),
        })
        .where(eq(schema.deliveryDetails.id, existing.id))
        .returning();
      const details = rows[0];
      if (!details) throw new NotFoundException(DETAILS_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "delivery_details.rider_assigned",
          targetType: "delivery_details",
          targetId: details.id,
          metadata: { orderId: params.orderId, riderId: params.riderId },
        },
        tx,
      );
      return details;
    });
  }

  async updateStatus(params: UpdateDeliveryStatusParams): Promise<DeliveryDetailsRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await assertDeliveryOrder(tx, params.orderId);

      const existingRows = await tx.select().from(schema.deliveryDetails).where(eq(schema.deliveryDetails.orderId, params.orderId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(DETAILS_NOT_FOUND);

      const rows = await tx
        .update(schema.deliveryDetails)
        .set({ deliveryStatus: params.status, updatedAt: new Date() })
        .where(eq(schema.deliveryDetails.id, existing.id))
        .returning();
      const details = rows[0];
      if (!details) throw new NotFoundException(DETAILS_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "delivery_details.status_updated",
          targetType: "delivery_details",
          targetId: details.id,
          metadata: { orderId: params.orderId, status: params.status },
        },
        tx,
      );
      return details;
    });
  }
}

async function assertDeliveryOrder(tx: Database, orderId: string): Promise<void> {
  const orderRows = await tx.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  const order = orderRows[0];
  if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
  if (order.orderType !== "delivery") throw new BadRequestException(NOT_A_DELIVERY_ORDER);
}
