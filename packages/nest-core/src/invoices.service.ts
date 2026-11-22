import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { applyFixedDiscount, applyPercentageDiscount, money } from "@mezbaan/domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { OutboxService } from "./outbox.service.js";
import type { OrderItemRecord } from "./order-items.service.js";
import { computeOrderTotal } from "./orders.service.js";
import { isUniqueViolation } from "./pg-error.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import type { AppliedTaxRule } from "./tax-rules.service.js";

export interface InvoiceRecord {
  id: string;
  branchId: string;
  orderId: string;
  deviceId: string;
  documentNumber: string;
  subtotalMinor: bigint;
  serviceChargeMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  currency: string;
  pricingMode: "inclusive" | "exclusive";
  taxRateBasisPoints: number;
  serviceChargeRateBasisPoints: number | null;
  appliedTaxRules: AppliedTaxRule[];
  actorUserId: string;
  createdAt: Date;
}

export interface GenerateInvoiceParams {
  restaurantId: string;
  orderId: string;
  deviceId: string;
  actorUserId: string;
  /** P2-21: bill only these items (must be currently unbilled, must belong to this order) rather than every unbilled item — the "split by item" primitive. */
  itemIds?: string[];
}

export interface SplitBySeatParams {
  restaurantId: string;
  orderId: string;
  deviceId: string;
  actorUserId: string;
}

export interface SplitByItemsParams {
  restaurantId: string;
  orderId: string;
  deviceId: string;
  actorUserId: string;
  groups: string[][];
}

const ORDER_NOT_FOUND = "Order not found";
const ORDER_NOT_CLOSED = "an invoice can only be generated for a closed order";
const ORDER_HAS_NO_ITEMS = "cannot generate an invoice for an order with no items";
const ALL_ITEMS_ALREADY_INVOICED = "every item on this order has already been invoiced or voided";
const ITEMS_NOT_FOUND = "one or more items don't belong to this order, or have already been invoiced";
const EMPTY_GROUP_NOT_ALLOWED = "a split group must contain at least one item";
const DEVICE_NOT_FOUND = "Device not found";
const DEVICE_WRONG_BRANCH = "this device does not belong to the order's branch";
const DEVICE_REVOKED = "this device has been revoked";

/**
 * P2-18/P2-21: turns a closed order's (currently unbilled) items into a
 * financial-ledger invoice row. Deliberately a second step after
 * OrdersService.close (P2-13), not folded into it — closing locks further
 * edits to the order's items (OrderItemsService.requireOpenOrder already
 * enforces that), while generating an invoice is the separate act of fixing
 * a document number and a computed total against now-locked content. No
 * new pricing happens here: totals come from the order's own already
 * price-list-versioned items (P2-12) through packages/domain's pure money
 * math (computeOrderTotal, shared with OrdersService.getTableTab) and
 * TaxCalculationService's existing preview (P2-05).
 *
 * P2-21 is what makes "a closed order" and "one invoice" no longer the same
 * thing: `generate` can be scoped to a named subset of the order's items
 * (`itemIds`), and `splitBySeat`/`splitByItems` are thin wrappers that call
 * it once per group — each call is its own transaction, its own document
 * number, and locks exactly the item rows it's about to bill
 * (`SELECT ... FOR UPDATE`) so two concurrent split calls can never bill the
 * same item twice.
 */
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly taxCalculationService: TaxCalculationService,
    // P2-26: optional so every existing test file instantiating InvoicesService
    // directly with 3 arguments still compiles unchanged, same precedent as
    // OrdersService.businessDaysService (P2-30) and PriceListsService.menuSnapshotCacheService
    // (P2-43). Without it, generate() simply doesn't enqueue a reconciliation job.
    @Optional() private readonly outboxService?: OutboxService,
  ) {}

  async generate(params: GenerateInvoiceParams): Promise<InvoiceRecord> {
    if (params.itemIds !== undefined && params.itemIds.length === 0) throw new BadRequestException(EMPTY_GROUP_NOT_ALLOWED);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const orderRows = await tx
        .select()
        .from(schema.orders)
        .where(and(eq(schema.orders.id, params.orderId), eq(schema.orders.restaurantId, params.restaurantId)));
      const order = orderRows[0];
      if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
      if (order.status !== "closed") throw new BadRequestException(ORDER_NOT_CLOSED);

      const deviceRows = await tx
        .select()
        .from(schema.devices)
        .where(and(eq(schema.devices.id, params.deviceId), eq(schema.devices.restaurantId, params.restaurantId)));
      const device = deviceRows[0];
      if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
      if (device.branchId !== order.branchId) throw new BadRequestException(DEVICE_WRONG_BRANCH);
      if (device.status !== "active") throw new BadRequestException(DEVICE_REVOKED);

      // Locked for the rest of this transaction — the real guard against two
      // concurrent split calls both finding the same item "unbilled" and both
      // billing it, same SELECT ... FOR UPDATE convention as P2-16/P2-20.
      const targetRows = await tx
        .select()
        .from(schema.orderItems)
        .where(
          params.itemIds
            ? and(eq(schema.orderItems.orderId, params.orderId), inArray(schema.orderItems.id, params.itemIds))
            : and(eq(schema.orderItems.orderId, params.orderId), isNull(schema.orderItems.invoiceId), isNull(schema.orderItems.voidedAt)),
        )
        .for("update");

      let targetItems = targetRows;
      if (params.itemIds) {
        // P2-23: a voided item can never be billed, named explicitly or not —
        // same reasoning as "already invoiced," just a different final state.
        if (targetRows.some((row) => row.invoiceId !== null || row.voidedAt !== null) || targetRows.length !== params.itemIds.length) {
          throw new NotFoundException(ITEMS_NOT_FOUND);
        }
      } else if (targetRows.length === 0) {
        const anyItemRows = await tx.select({ id: schema.orderItems.id }).from(schema.orderItems).where(eq(schema.orderItems.orderId, params.orderId)).limit(1);
        throw new BadRequestException(anyItemRows.length === 0 ? ORDER_HAS_NO_ITEMS : ALL_ITEMS_ALREADY_INVOICED);
      }

      const items = await attachModifiersTo(tx, targetItems);
      const rawSubtotal = computeOrderTotal(items, order.currency);
      let subtotal = rawSubtotal;

      // P2-22: a bill-level discount only has a well-defined meaning for a whole-
      // order invoice — a split-by-item/seat invoice covers a subset with no single
      // "whole bill" to discount, so it's deliberately not applied there.
      if (!params.itemIds) {
        if (order.discountPercentBasisPoints !== null) {
          subtotal = applyPercentageDiscount(subtotal, order.discountPercentBasisPoints).afterDiscount;
        } else if (order.discountAmountMinor !== null) {
          subtotal = applyFixedDiscount(subtotal, money(order.discountAmountMinor, subtotal.currency)).afterDiscount;
        }
      }
      // P2-26: recorded as a precise fact (not re-derivable later from order.discountPercentBasisPoints
      // alone, since that field can change after the fact and this invoice's own discount is fixed at
      // generation time) so reconciliation can recompute subtotalMinor exactly.
      const billDiscountAppliedMinor = rawSubtotal.amountMinor - subtotal.amountMinor;

      const charges = await this.taxCalculationService.previewCharges({
        restaurantId: params.restaurantId,
        branchId: order.branchId,
        orderType: order.orderType,
        subtotalMinor: subtotal.amountMinor,
        currency: order.currency,
      });

      const branchRows = await tx.select({ branchNumber: schema.branches.branchNumber }).from(schema.branches).where(eq(schema.branches.id, order.branchId));
      const branch = branchRows[0];
      if (!branch) throw new Error("generate: order's branch disappeared mid-transaction");

      // Atomic: a plain UPDATE already serializes two concurrent callers against the
      // same device row, so whichever commits second genuinely gets the next number,
      // never a repeat — no explicit row lock needed beyond what the UPDATE itself takes.
      const sequenceRows = await tx
        .update(schema.devices)
        .set({ nextInvoiceSequence: sql`${schema.devices.nextInvoiceSequence} + 1` })
        .where(eq(schema.devices.id, params.deviceId))
        .returning({ sequence: schema.devices.nextInvoiceSequence });
      const consumedSequence = sequenceRows[0]!.sequence - 1;
      const documentNumber = `B${branch.branchNumber}-T${device.terminalNumber}-${String(consumedSequence).padStart(6, "0")}`;

      let rows: Array<typeof schema.invoices.$inferSelect>;
      try {
        rows = await tx
          .insert(schema.invoices)
          .values({
            restaurantId: params.restaurantId,
            branchId: order.branchId,
            orderId: params.orderId,
            deviceId: params.deviceId,
            documentNumber,
            subtotalMinor: subtotal.amountMinor,
            serviceChargeMinor: charges.serviceCharge.amountMinor,
            taxMinor: charges.tax.amountMinor,
            totalMinor: charges.total.amountMinor,
            currency: order.currency,
            pricingMode: charges.pricingMode,
            taxRateBasisPoints: charges.taxRateBasisPoints,
            serviceChargeRateBasisPoints: charges.serviceChargeRateBasisPoints,
            appliedTaxRules: charges.appliedTaxRules,
            billDiscountAppliedMinor,
            actorUserId: params.actorUserId,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error("generate: document number collision — this should never happen under the per-device sequence lock");
        throw error;
      }
      const invoice = rows[0];
      if (!invoice) throw new Error("generate: invoice insert returned no row");

      await tx
        .update(schema.orderItems)
        .set({ invoiceId: invoice.id, updatedAt: new Date() })
        .where(inArray(schema.orderItems.id, targetItems.map((item) => item.id)));

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "invoice.generated",
          targetType: "invoice",
          targetId: invoice.id,
          metadata: { orderId: params.orderId, documentNumber, totalMinor: invoice.totalMinor.toString(), itemCount: targetItems.length },
        },
        tx,
      );

      // P2-26: same transaction as the invoice insert (rule: "the outbox row is
      // written in the same transaction as the business change") — if this
      // commits, a reconciliation check is guaranteed to eventually run; if the
      // transaction rolls back, no orphaned outbox row is left behind either.
      await this.outboxService?.record(
        { restaurantId: params.restaurantId, aggregateType: "invoice", aggregateId: invoice.id, eventType: "invoice.generated", payload: { invoiceId: invoice.id } },
        tx,
      );

      return toInvoiceRecord(invoice);
    });
  }

  /** P2-21: one invoice per distinct seatNumber among this order's currently-unbilled items (null seat groups together as one shared invoice). */
  async splitBySeat(params: SplitBySeatParams): Promise<InvoiceRecord[]> {
    const unbilled = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx.select({ id: schema.orderItems.id, seatNumber: schema.orderItems.seatNumber }).from(schema.orderItems).where(
        and(eq(schema.orderItems.orderId, params.orderId), isNull(schema.orderItems.invoiceId), isNull(schema.orderItems.voidedAt)),
      ),
    );
    if (unbilled.length === 0) throw new BadRequestException(ALL_ITEMS_ALREADY_INVOICED);

    const groups = new Map<string, string[]>();
    for (const item of unbilled) {
      const key = item.seatNumber === null ? "unassigned" : String(item.seatNumber);
      const group = groups.get(key) ?? [];
      group.push(item.id);
      groups.set(key, group);
    }

    const invoices: InvoiceRecord[] = [];
    for (const itemIds of groups.values()) {
      invoices.push(await this.generate({ restaurantId: params.restaurantId, orderId: params.orderId, deviceId: params.deviceId, actorUserId: params.actorUserId, itemIds }));
    }
    return invoices;
  }

  /** P2-21: one invoice per caller-chosen group of item ids — the "split by item" primitive. */
  async splitByItems(params: SplitByItemsParams): Promise<InvoiceRecord[]> {
    if (params.groups.some((group) => group.length === 0)) throw new BadRequestException(EMPTY_GROUP_NOT_ALLOWED);

    const invoices: InvoiceRecord[] = [];
    for (const itemIds of params.groups) {
      invoices.push(await this.generate({ restaurantId: params.restaurantId, orderId: params.orderId, deviceId: params.deviceId, actorUserId: params.actorUserId, itemIds }));
    }
    return invoices;
  }

  async getByOrderId(params: { restaurantId: string; orderId: string }): Promise<InvoiceRecord | null> {
    const all = await this.listByOrderId(params);
    return all[0] ?? null;
  }

  async listByOrderId(params: { restaurantId: string; orderId: string }): Promise<InvoiceRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.orderId, params.orderId));
      return rows.map(toInvoiceRecord);
    });
  }
}

/** Mirrors OrderItemsService's own private attachModifiers — duplicated rather than shared because that method only ever runs inside OrderItemsService's own transaction, and this one needs to run inside InvoicesService's (the lock on order_items has to be part of the same transaction as the invoice insert that follows it). */
/** Exported for ReconciliationService (P2-26) — it needs the exact same
 * item-plus-modifiers shape computeOrderTotal expects, re-derived fresh
 * from the database rather than reusing anything InvoicesService already
 * computed in memory. */
export async function attachModifiersTo(tx: Database, items: Array<typeof schema.orderItems.$inferSelect>): Promise<OrderItemRecord[]> {
  if (items.length === 0) return [];
  const modifierRows = await tx.select().from(schema.orderItemModifiers).where(inArray(schema.orderItemModifiers.orderItemId, items.map((i) => i.id)));
  return items.map((item) => ({ ...item, modifiers: modifierRows.filter((m) => m.orderItemId === item.id) })) as OrderItemRecord[];
}

function toInvoiceRecord(row: typeof schema.invoices.$inferSelect): InvoiceRecord {
  return {
    id: row.id,
    branchId: row.branchId,
    orderId: row.orderId,
    deviceId: row.deviceId,
    documentNumber: row.documentNumber,
    subtotalMinor: row.subtotalMinor,
    serviceChargeMinor: row.serviceChargeMinor,
    taxMinor: row.taxMinor,
    totalMinor: row.totalMinor,
    currency: row.currency,
    pricingMode: row.pricingMode as "inclusive" | "exclusive",
    taxRateBasisPoints: row.taxRateBasisPoints,
    serviceChargeRateBasisPoints: row.serviceChargeRateBasisPoints,
    appliedTaxRules: row.appliedTaxRules as AppliedTaxRule[],
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
  };
}
