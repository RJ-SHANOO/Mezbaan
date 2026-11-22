import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { ManagerPinService } from "./manager-pin.service.js";

export interface VoidReasonCodeRecord {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetVoidReasonCodeParams {
  restaurantId: string;
  actorUserId: string;
  code: string;
  label: string;
  isActive?: boolean;
}

export interface VoidItemParams {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  itemId: string;
  reasonCode: string;
  managerUserId?: string;
  managerPin?: string;
}

export interface VoidOutcome {
  requiredApproval: boolean;
  approvedByUserId: string | null;
}

const ORDER_NOT_FOUND = "Order not found";
const ORDER_NOT_OPEN = "an item can only be voided on an open order";
const ITEM_NOT_FOUND = "Order item not found";
const ALREADY_VOIDED = "this item has already been voided";
const ALREADY_INVOICED = "this item has already been invoiced — a void can't undo a billed item, that's a refund's job";
const REASON_CODE_NOT_FOUND = "this void reason code doesn't exist or is no longer active";
const APPROVAL_REQUIRED = "this item has already been fired to the kitchen and needs a manager's approval to void (managerUserId and managerPin)";

/**
 * P2-23: voids an order item before or after it's been fired to the kitchen
 * (P2-15). Before firing, the kitchen never started on it — no approval
 * needed, just a reason. After firing, the kitchen already spent time or
 * ingredients on it — the same ManagerPinService (P1-13) P2-22 just wired
 * up for real, checked against the already-pre-seeded pos.void.approve
 * permission (seed.ts had this waiting since P1-09, long before any voiding
 * flow existed to need it).
 *
 * A void keeps the row rather than deleting it (rule 6: "always recorded...
 * visible in reports" — a deleted row isn't visible anywhere).
 * OrderItemsService.removeItem (P2-12's plain "oops" correction) now refuses
 * a fired item outright specifically so it can't be used to bypass this
 * approval gate — voiding is the only path once the kitchen has seen an
 * item. computeOrderTotal (OrdersService) and invoice generation
 * (InvoicesService) both already exclude a voided item from any total or
 * from ever being billed.
 */
@Injectable()
export class VoidsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly managerPinService: ManagerPinService,
  ) {}

  async listReasonCodes(restaurantId: string): Promise<VoidReasonCodeRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.voidReasonCodes));
  }

  async setReasonCode(params: SetVoidReasonCodeParams): Promise<VoidReasonCodeRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.voidReasonCodes)
        .values({ restaurantId: params.restaurantId, code: params.code, label: params.label, isActive: params.isActive ?? true })
        .onConflictDoUpdate({
          target: [schema.voidReasonCodes.restaurantId, schema.voidReasonCodes.code],
          set: { label: params.label, isActive: params.isActive ?? true, updatedAt: new Date() },
        })
        .returning();
      const reasonCode = rows[0];
      if (!reasonCode) throw new Error("setReasonCode: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "void_reason_code.set", targetType: "void_reason_code", targetId: reasonCode.id, metadata: { code: params.code } },
        tx,
      );
      return reasonCode;
    });
  }

  async voidItem(params: VoidItemParams): Promise<VoidOutcome> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const order = await this.requireOpenOrder(tx, params.restaurantId, params.orderId);
      await this.requireActiveReasonCode(tx, params.reasonCode);

      // Row-locked so two concurrent void attempts on the same item (or a void
      // racing a fire) can't both see "not yet voided/fired" and both act —
      // same SELECT ... FOR UPDATE convention as P2-16/P2-20/P2-21.
      const itemRows = await tx
        .select()
        .from(schema.orderItems)
        .where(and(eq(schema.orderItems.id, params.itemId), eq(schema.orderItems.restaurantId, params.restaurantId)))
        .for("update");
      const item = itemRows[0];
      if (!item || item.orderId !== params.orderId) throw new NotFoundException(ITEM_NOT_FOUND);
      if (item.voidedAt !== null) throw new BadRequestException(ALREADY_VOIDED);
      if (item.invoiceId !== null) throw new BadRequestException(ALREADY_INVOICED);

      const requiredApproval = item.firedAt !== null;
      let approvedByUserId: string | null = null;
      if (requiredApproval) {
        if (!params.managerUserId || !params.managerPin) throw new BadRequestException(APPROVAL_REQUIRED);
        await this.managerPinService.approve({
          restaurantId: params.restaurantId,
          branchId: order.branchId,
          managerUserId: params.managerUserId,
          pin: params.managerPin,
          requiredPermission: "pos.void.approve",
          action: "order_item.void",
        });
        approvedByUserId = params.managerUserId;
      }

      await tx
        .update(schema.orderItems)
        .set({ voidedAt: new Date(), voidedByUserId: params.actorUserId, voidReasonCode: params.reasonCode, voidApprovedByUserId: approvedByUserId, updatedAt: new Date() })
        .where(eq(schema.orderItems.id, item.id));

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "order_item.voided",
          targetType: "order_item",
          targetId: item.id,
          metadata: { reasonCode: params.reasonCode, firedBeforeVoid: requiredApproval, approvedByUserId },
        },
        tx,
      );

      return { requiredApproval, approvedByUserId };
    });
  }

  private async requireOpenOrder(tx: Database, restaurantId: string, orderId: string): Promise<{ branchId: string }> {
    const rows = await tx
      .select({ id: schema.orders.id, branchId: schema.orders.branchId, status: schema.orders.status })
      .from(schema.orders)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.restaurantId, restaurantId)));
    const order = rows[0];
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    if (order.status !== "open") throw new BadRequestException(ORDER_NOT_OPEN);
    return order;
  }

  private async requireActiveReasonCode(tx: Database, code: string): Promise<void> {
    const rows = await tx.select({ isActive: schema.voidReasonCodes.isActive }).from(schema.voidReasonCodes).where(eq(schema.voidReasonCodes.code, code));
    if (!rows[0] || !rows[0].isActive) throw new BadRequestException(REASON_CODE_NOT_FOUND);
  }
}
