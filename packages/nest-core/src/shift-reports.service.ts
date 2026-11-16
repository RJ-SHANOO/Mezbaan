import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, lte } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";
import type { PaymentMethod } from "./payment-method-settings.service.js";

export interface SalesSummary {
  salesByMethod: Record<PaymentMethod, bigint>;
  cashSalesMinor: bigint;
  cashInMinor: bigint;
  cashOutMinor: bigint;
  expectedCashMinor: bigint;
}

export interface XReport extends SalesSummary {
  shiftId: string;
  openingFloatMinor: bigint;
  asOf: Date;
}

export interface ZReport extends SalesSummary {
  shiftId: string;
  openingFloatMinor: bigint;
  countedCashMinor: bigint;
  overShortMinor: bigint;
  closedAt: Date;
}

const SHIFT_NOT_FOUND = "Shift not found";
const SHIFT_NOT_CLOSED = "a Z report can only be generated once the shift is closed";
const ALL_METHODS: PaymentMethod[] = ["cash", "card", "bank_transfer", "wallet"];

/**
 * P2-29: over/short, the X report (mid-shift snapshot) and the Z report
 * (end-of-shift). Both reports derive "sales so far" by joining payments to
 * the invoices generated on the shift's own device within the shift's time
 * window — payments/invoices (P2-18/19/20) were never given a shiftId
 * column of their own, so this reads the existing data by device+time
 * rather than requiring a schema or write-path change to those two
 * already-shipped tasks.
 *
 * Known, documented gap: refunds (P2-24) carry no payment method of their
 * own, so a cash refund can't be distinguished from a card refund here —
 * `expectedCashMinor` does not subtract refunds at all. Reconciling that
 * needs a method column on `refunds` that doesn't exist yet; flagged here
 * rather than guessed at.
 */
@Injectable()
export class ShiftReportsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getXReport(params: { restaurantId: string; shiftId: string }): Promise<XReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const shift = await this.requireShift(tx, params.shiftId);
      const asOf = new Date();
      const summary = await this.computeSalesSummary(tx, shift, asOf);
      return { shiftId: shift.id, openingFloatMinor: shift.openingFloatMinor, asOf, ...summary };
    });
  }

  async getZReport(params: { restaurantId: string; shiftId: string }): Promise<ZReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const shift = await this.requireShift(tx, params.shiftId);
      if (shift.status !== "closed" || !shift.closedAt || shift.countedCashMinor === null) throw new BadRequestException(SHIFT_NOT_CLOSED);

      const summary = await this.computeSalesSummary(tx, shift, shift.closedAt);
      return {
        shiftId: shift.id,
        openingFloatMinor: shift.openingFloatMinor,
        countedCashMinor: shift.countedCashMinor,
        overShortMinor: shift.countedCashMinor - summary.expectedCashMinor,
        closedAt: shift.closedAt,
        ...summary,
      };
    });
  }

  private async computeSalesSummary(tx: Database, shift: { id: string; deviceId: string; openedAt: Date; openingFloatMinor: bigint }, endTime: Date): Promise<SalesSummary> {
    const paymentRows = await tx
      .select({ method: schema.payments.method, amountMinor: schema.payments.amountMinor })
      .from(schema.payments)
      .innerJoin(schema.invoices, eq(schema.payments.invoiceId, schema.invoices.id))
      .where(and(eq(schema.invoices.deviceId, shift.deviceId), gte(schema.payments.createdAt, shift.openedAt), lte(schema.payments.createdAt, endTime)));

    const salesByMethod = Object.fromEntries(ALL_METHODS.map((method) => [method, 0n])) as Record<PaymentMethod, bigint>;
    for (const row of paymentRows) {
      salesByMethod[row.method] += row.amountMinor;
    }

    const movementRows = await tx.select({ direction: schema.cashMovements.direction, amountMinor: schema.cashMovements.amountMinor }).from(schema.cashMovements).where(eq(schema.cashMovements.shiftId, shift.id));
    const cashInMinor = movementRows.filter((row) => row.direction === "in").reduce((total, row) => total + row.amountMinor, 0n);
    const cashOutMinor = movementRows.filter((row) => row.direction === "out").reduce((total, row) => total + row.amountMinor, 0n);

    const cashSalesMinor = salesByMethod.cash;
    const expectedCashMinor = shift.openingFloatMinor + cashSalesMinor + cashInMinor - cashOutMinor;

    return { salesByMethod, cashSalesMinor, cashInMinor, cashOutMinor, expectedCashMinor };
  }

  private async requireShift(tx: Database, shiftId: string): Promise<typeof schema.shifts.$inferSelect> {
    const rows = await tx.select().from(schema.shifts).where(eq(schema.shifts.id, shiftId));
    const shift = rows[0];
    if (!shift) throw new NotFoundException(SHIFT_NOT_FOUND);
    return shift;
  }
}
