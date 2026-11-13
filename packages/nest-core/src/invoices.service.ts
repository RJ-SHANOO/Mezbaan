import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { OrderItemsService } from "./order-items.service.js";
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
}

const ORDER_NOT_FOUND = "Order not found";
const ORDER_NOT_CLOSED = "an invoice can only be generated for a closed order";
const ORDER_HAS_NO_ITEMS = "cannot generate an invoice for an order with no items";
const INVOICE_ALREADY_EXISTS = "this order already has an invoice";
const DEVICE_NOT_FOUND = "Device not found";
const DEVICE_WRONG_BRANCH = "this device does not belong to the order's branch";
const DEVICE_REVOKED = "this device has been revoked";

/**
 * P2-18: turns a closed order into the first real financial-ledger row in
 * this codebase. Deliberately a second step after OrdersService.close
 * (P2-13), not folded into it — closing locks further edits to the order's
 * items (OrderItemsService.requireOpenOrder already enforces that), while
 * generating the invoice is the separate act of fixing a document number and
 * a computed total against that now-locked content. No new pricing happens
 * here: totals come from the order's own already price-list-versioned items
 * (P2-12) through packages/domain's pure money math (computeOrderTotal,
 * shared with OrdersService.getTableTab) and TaxCalculationService's
 * existing preview (P2-05) — this task only persists that result.
 */
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly orderItemsService: OrderItemsService,
    private readonly taxCalculationService: TaxCalculationService,
  ) {}

  async generate(params: GenerateInvoiceParams): Promise<InvoiceRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const orderRows = await tx.select().from(schema.orders).where(eq(schema.orders.id, params.orderId));
      const order = orderRows[0];
      if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
      if (order.status !== "closed") throw new BadRequestException(ORDER_NOT_CLOSED);

      const existingRows = await tx.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.orderId, params.orderId));
      if (existingRows.length > 0) throw new BadRequestException(INVOICE_ALREADY_EXISTS);

      const deviceRows = await tx.select().from(schema.devices).where(eq(schema.devices.id, params.deviceId));
      const device = deviceRows[0];
      if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
      if (device.branchId !== order.branchId) throw new BadRequestException(DEVICE_WRONG_BRANCH);
      if (device.status !== "active") throw new BadRequestException(DEVICE_REVOKED);

      const items = await this.orderItemsService.list(params.restaurantId, params.orderId);
      if (items.length === 0) throw new BadRequestException(ORDER_HAS_NO_ITEMS);
      const subtotal = computeOrderTotal(items, order.currency);

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
            actorUserId: params.actorUserId,
          })
          .returning();
      } catch (error) {
        // The two-step check above (read, then insert) can still lose a race to
        // another concurrent generate() call on the same order — invoices_order_id_idx
        // is the real guard, same convention as P2-16's table-occupancy index.
        if (isUniqueViolation(error)) throw new BadRequestException(INVOICE_ALREADY_EXISTS);
        throw error;
      }
      const invoice = rows[0];
      if (!invoice) throw new Error("generate: invoice insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "invoice.generated",
          targetType: "invoice",
          targetId: invoice.id,
          metadata: { orderId: params.orderId, documentNumber, totalMinor: invoice.totalMinor.toString() },
        },
        tx,
      );

      return toInvoiceRecord(invoice);
    });
  }

  async getByOrderId(params: { restaurantId: string; orderId: string }): Promise<InvoiceRecord | null> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.orderId, params.orderId));
      const invoice = rows[0];
      return invoice ? toInvoiceRecord(invoice) : null;
    });
  }
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
