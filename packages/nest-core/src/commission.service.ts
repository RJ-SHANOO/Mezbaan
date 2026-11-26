import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { applyPercentage, money, negate } from "@mezbaan/domain";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface CommissionEntryRecord {
  id: string;
  branchId: string;
  invoiceId: string;
  entryType: "charge" | "reversal";
  paymentId: string | null;
  refundId: string | null;
  amountMinor: bigint;
  rateBasisPoints: number;
  currency: string;
  createdAt: Date;
}

export interface ProcessPaymentParams {
  restaurantId: string;
  paymentId: string;
}

export interface ProcessRefundParams {
  restaurantId: string;
  refundId: string;
}

const PAYMENT_NOT_FOUND = "Payment not found";
const REFUND_NOT_FOUND = "Refund not found";

/**
 * P3-34: commission entries — the platform's own revenue, one row per
 * payment actually collected (never per invoice; P3-35 is what adds the
 * reversal when a refund later gives some of that back). Idempotent via
 * a pre-write existence check against commission_entries.paymentId (also
 * backed by that column's own unique index) — the same "the outbox
 * retries a thrown handler, but a handler that succeeded and then lost
 * the race to mark its own outbox row processed shouldn't double-charge"
 * reasoning SalesStockDeductionService already documents. `rateBasisPoints`
 * is read fresh from restaurants.commissionRateBasisPoints *at process
 * time* and then frozen into this row forever — see
 * commission-entries.ts's own docs for why that still matters even though
 * the column is already permanently locked at the database level today.
 */
@Injectable()
export class CommissionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async processPayment(params: ProcessPaymentParams): Promise<CommissionEntryRecord | null> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existing = await tx.select({ id: schema.commissionEntries.id }).from(schema.commissionEntries).where(eq(schema.commissionEntries.paymentId, params.paymentId));
      if (existing.length > 0) return null;

      const paymentRows = await tx.select().from(schema.payments).where(eq(schema.payments.id, params.paymentId));
      const payment = paymentRows[0];
      if (!payment) throw new NotFoundException(PAYMENT_NOT_FOUND);

      const restaurantRows = await tx.select({ commissionRateBasisPoints: schema.restaurants.commissionRateBasisPoints }).from(schema.restaurants).where(eq(schema.restaurants.id, params.restaurantId));
      const restaurant = restaurantRows[0];
      if (!restaurant) throw new Error("processPayment: restaurant disappeared mid-transaction");

      const commission = applyPercentage(money(payment.amountMinor, payment.currency), restaurant.commissionRateBasisPoints);

      const rows = await tx
        .insert(schema.commissionEntries)
        .values({
          restaurantId: params.restaurantId,
          branchId: payment.branchId,
          invoiceId: payment.invoiceId,
          entryType: "charge",
          paymentId: payment.id,
          amountMinor: commission.amountMinor,
          rateBasisPoints: restaurant.commissionRateBasisPoints,
          currency: commission.currency,
        })
        .returning();
      const entry = rows[0];
      if (!entry) throw new Error("processPayment: commission entry insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: payment.branchId,
          actorUserId: payment.actorUserId,
          action: "commission_entry.recorded",
          targetType: "commission_entry",
          targetId: entry.id,
          metadata: { paymentId: payment.id, amountMinor: entry.amountMinor.toString(), rateBasisPoints: entry.rateBasisPoints },
        },
        tx,
      );

      return entry;
    });
  }

  /**
   * P3-35: the compensating row for a refund — see commission-entries.ts's
   * own docs for why this is a signed-negative "reversal" row in the same
   * table rather than a separate one. Idempotent the same way as
   * processPayment: a pre-write existence check against this refund's id
   * (also backed by that column's own partial unique index).
   */
  async processRefund(params: ProcessRefundParams): Promise<CommissionEntryRecord | null> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existing = await tx.select({ id: schema.commissionEntries.id }).from(schema.commissionEntries).where(eq(schema.commissionEntries.refundId, params.refundId));
      if (existing.length > 0) return null;

      const refundRows = await tx.select().from(schema.refunds).where(eq(schema.refunds.id, params.refundId));
      const refund = refundRows[0];
      if (!refund) throw new NotFoundException(REFUND_NOT_FOUND);

      const restaurantRows = await tx.select({ commissionRateBasisPoints: schema.restaurants.commissionRateBasisPoints }).from(schema.restaurants).where(eq(schema.restaurants.id, params.restaurantId));
      const restaurant = restaurantRows[0];
      if (!restaurant) throw new Error("processRefund: restaurant disappeared mid-transaction");

      const reversal = negate(applyPercentage(money(refund.amountMinor, refund.currency), restaurant.commissionRateBasisPoints));

      const rows = await tx
        .insert(schema.commissionEntries)
        .values({
          restaurantId: params.restaurantId,
          branchId: refund.branchId,
          invoiceId: refund.invoiceId,
          entryType: "reversal",
          refundId: refund.id,
          amountMinor: reversal.amountMinor,
          rateBasisPoints: restaurant.commissionRateBasisPoints,
          currency: reversal.currency,
        })
        .returning();
      const entry = rows[0];
      if (!entry) throw new Error("processRefund: commission entry insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: refund.branchId,
          actorUserId: refund.actorUserId,
          action: "commission_entry.reversed",
          targetType: "commission_entry",
          targetId: entry.id,
          metadata: { refundId: refund.id, amountMinor: entry.amountMinor.toString(), rateBasisPoints: entry.rateBasisPoints },
        },
        tx,
      );

      return entry;
    });
  }
}
