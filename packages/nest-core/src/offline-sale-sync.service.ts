import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@mezbaan/db";
import type { OfflineSaleCompletedPayload } from "@mezbaan/contracts";
import { AuditLogService } from "./audit-log.service.js";
import { OutboxService } from "./outbox.service.js";

export interface ProcessOfflineSaleParams {
  restaurantId: string;
  branchId: string;
  deviceId: string;
  payload: OfflineSaleCompletedPayload;
}

const DEVICE_NOT_FOUND = "Device not found";
const NO_DEFAULT_ACTOR = "this device has no default actor configured — an admin must set one (PUT /devices/:id/default-actor) before its offline sales can sync";
const DINE_IN_NOT_SUPPORTED = "offline dine-in sales are not yet supported — the offline cart has no table selection, so there is no tableId to record";

/**
 * P2-45 (exit-gate hardening): turns a synced `offline_sale.completed`
 * operation into a real order + order_items + invoice — the piece the
 * exit gate's "totals match between terminals and server" needs that
 * didn't exist before (SyncService previously only stored the raw
 * operation, per its own long-standing doc comment: "no business write to
 * run per operation_type yet").
 *
 * Deliberately NOT built on InvoicesService.generate: that service always
 * computes its own fresh totals from order_items via TaxCalculationService,
 * which would make it impossible to ever observe a mismatch — reconciliation
 * would just be comparing the invoice against itself. Rule 3 instead asks
 * for "the server recalculates each synced sale and flags any mismatch" —
 * so this stores the terminal's OWN already-computed totals (the recorded
 * sale, rule 4) as the invoice, then enqueues the exact same "invoice.generated"
 * outbox event InvoicesService.generate already uses, so P2-26's existing
 * reconciliation handler independently recomputes and flags a real mismatch
 * if one exists — no new reconciliation code needed.
 */
@Injectable()
export class OfflineSaleSyncService {
  constructor(
    private readonly auditLogService: AuditLogService,
    // Optional for the same reason InvoicesService's is — every existing test
    // instantiating this service directly still compiles unchanged.
    @Optional() private readonly outboxService?: OutboxService,
  ) {}

  /** Caller (SyncService) must run this inside the same transaction as the
   * sync_operations row insert — if this throws, that insert rolls back too,
   * so a rejected operation leaves nothing partial behind and can be retried
   * from scratch exactly like it never arrived (rule 9). */
  async process(tx: Database, params: ProcessOfflineSaleParams): Promise<void> {
    if (params.payload.orderType === "dine_in") {
      throw new BadRequestException(DINE_IN_NOT_SUPPORTED);
    }

    const deviceRows = await tx.select().from(schema.devices).where(eq(schema.devices.id, params.deviceId));
    const device = deviceRows[0];
    if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
    if (!device.defaultActorUserId) throw new BadRequestException(NO_DEFAULT_ACTOR);
    const actorUserId = device.defaultActorUserId;
    const now = new Date();

    const orderRows = await tx
      .insert(schema.orders)
      .values({
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        orderType: params.payload.orderType,
        tableId: null,
        status: "closed",
        currency: params.payload.currency,
        openedByUserId: actorUserId,
        closedAt: now,
      })
      .returning();
    const order = orderRows[0];
    if (!order) throw new Error("process: order insert returned no row");

    await tx.insert(schema.orderStatusHistory).values([
      { restaurantId: params.restaurantId, orderId: order.id, fromStatus: null, toStatus: "open", actorUserId, reason: "offline sale synced" },
      { restaurantId: params.restaurantId, orderId: order.id, fromStatus: "open", toStatus: "closed", actorUserId, reason: "offline sale synced" },
    ]);

    const itemIds: string[] = [];
    for (const line of params.payload.lines) {
      const itemRows = await tx
        .insert(schema.orderItems)
        .values({
          restaurantId: params.restaurantId,
          orderId: order.id,
          productId: line.productId,
          quantity: line.quantity,
          unitPriceMinor: BigInt(line.unitPriceMinor),
          currency: line.currency,
          priceListId: line.priceListId,
          priceListVersion: line.priceListVersion,
        })
        .returning({ id: schema.orderItems.id });
      const item = itemRows[0];
      if (!item) throw new Error("process: order item insert returned no row");
      itemIds.push(item.id);

      for (const modifier of line.modifiers) {
        await tx.insert(schema.orderItemModifiers).values({
          restaurantId: params.restaurantId,
          orderItemId: item.id,
          modifierOptionId: modifier.modifierOptionId,
          unitPriceMinor: BigInt(modifier.unitPriceMinor),
          currency: modifier.currency,
          priceListId: modifier.priceListId,
          priceListVersion: modifier.priceListVersion,
        });
      }
    }

    const invoiceRows = await tx
      .insert(schema.invoices)
      .values({
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        orderId: order.id,
        deviceId: params.deviceId,
        documentNumber: params.payload.documentNumber,
        subtotalMinor: BigInt(params.payload.subtotalMinor),
        serviceChargeMinor: BigInt(params.payload.serviceChargeMinor),
        taxMinor: BigInt(params.payload.taxMinor),
        totalMinor: BigInt(params.payload.totalMinor),
        currency: params.payload.currency,
        pricingMode: params.payload.pricingMode,
        taxRateBasisPoints: params.payload.taxRateBasisPoints,
        serviceChargeRateBasisPoints: params.payload.serviceChargeRateBasisPoints,
        appliedTaxRules: params.payload.appliedTaxRules,
        actorUserId,
      })
      .returning();
    const invoice = invoiceRows[0];
    if (!invoice) throw new Error("process: invoice insert returned no row");

    await tx.update(schema.orderItems).set({ invoiceId: invoice.id, updatedAt: now }).where(inArray(schema.orderItems.id, itemIds));

    await this.auditLogService.record(
      { restaurantId: params.restaurantId, branchId: params.branchId, actorUserId, deviceId: params.deviceId, action: "order.opened", targetType: "order", targetId: order.id, metadata: { source: "offline_sync" } },
      tx,
    );
    await this.auditLogService.record(
      { restaurantId: params.restaurantId, branchId: params.branchId, actorUserId, deviceId: params.deviceId, action: "order.closed", targetType: "order", targetId: order.id, metadata: { source: "offline_sync" } },
      tx,
    );
    await this.auditLogService.record(
      {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        actorUserId,
        deviceId: params.deviceId,
        action: "invoice.generated",
        targetType: "invoice",
        targetId: invoice.id,
        metadata: { orderId: order.id, documentNumber: invoice.documentNumber, totalMinor: invoice.totalMinor.toString(), source: "offline_sync" },
      },
      tx,
    );

    // P2-26: same event InvoicesService.generate already enqueues — its
    // reconciliation handler needs no change to also cover a synced offline
    // sale, which is exactly the scenario rule 3 is describing.
    await this.outboxService?.record(
      { restaurantId: params.restaurantId, aggregateType: "invoice", aggregateId: invoice.id, eventType: "invoice.generated", payload: { invoiceId: invoice.id } },
      tx,
    );
    // P3-17: same reasoning again — a synced offline sale is exactly a
    // "synced sale" this task's own title names, so it needs its stock
    // deducted the same as any invoice InvoicesService.generate produces.
    // This is deliberately NOT built on InvoicesService.generate (see this
    // file's own docs for why), so the event has to be enqueued here too
    // rather than inherited for free.
    await this.outboxService?.record(
      { restaurantId: params.restaurantId, aggregateType: "invoice", aggregateId: invoice.id, eventType: "invoice.stock_deduct", payload: { invoiceId: invoice.id } },
      tx,
    );
  }
}
