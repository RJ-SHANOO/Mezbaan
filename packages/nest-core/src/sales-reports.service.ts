import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { add, applyFixedDiscount, applyPercentageDiscount, money, multiply, sum } from "@mezbaan/domain";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { businessDateRangeToUtc } from "./business-date-range.js";
import { DATABASE } from "./db.module.js";
import type { PaymentMethod } from "./payment-method-settings.service.js";

export interface DailySalesSummary {
  businessDate: string;
  currency: string;
  orderCount: number;
  subtotalMinor: bigint;
  taxMinor: bigint;
  serviceChargeMinor: bigint;
  grossSalesMinor: bigint;
}

export interface PaymentBreakdown {
  businessDate: string;
  currency: string;
  byMethod: Record<PaymentMethod, bigint>;
  tipsMinor: bigint;
  totalMinor: bigint;
}

export interface VoidReportEntry {
  itemId: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  quantity: number;
  valueMinor: bigint;
  reasonCode: string | null;
  voidedByUserId: string;
  voidApprovedByUserId: string | null;
  voidedAt: Date;
}

export interface VoidReport {
  businessDate: string;
  currency: string;
  entries: VoidReportEntry[];
  totalValueMinor: bigint;
  countByReasonCode: Record<string, number>;
}

export interface DiscountReportEntry {
  itemId: string;
  orderId: string;
  discountMinor: bigint;
  reasonCode: string | null;
  approvedByUserId: string | null;
}

export interface DiscountReport {
  businessDate: string;
  currency: string;
  entries: DiscountReportEntry[];
  totalDiscountMinor: bigint;
  countByReasonCode: Record<string, number>;
}

export interface RefundReportEntry {
  refundId: string;
  invoiceId: string;
  amountMinor: bigint;
  reasonCode: string;
  approvedByUserId: string;
  createdAt: Date;
}

export interface RefundReport {
  businessDate: string;
  currency: string;
  entries: RefundReportEntry[];
  totalRefundedMinor: bigint;
  countByReasonCode: Record<string, number>;
}

const BRANCH_NOT_FOUND = "Branch not found";
const ALL_METHODS: PaymentMethod[] = ["cash", "card", "bank_transfer", "wallet"];
const FALLBACK_CURRENCY = "PKR";

/**
 * P2-40: basic, pilot-grade daily reports — a daily sales summary, a
 * payment-method breakdown, and void/discount/refund detail reports, each
 * scoped to one branch's business day (same branch-local-timezone
 * "business day" concept P2-30 introduced, not server UTC). Lives in
 * `api-reports`, its own separately deployable process (rule: "api-reports
 * fails → selling and stock continue; reports are delayed").
 *
 * Deliberately basic, matching this section's own heading — Phase 4's
 * P4-07/08 build the real comprehensive reporting (by hour/product/
 * category/staff/branch, tax/profit dashboards); this task only needs to
 * prove the pilot branch's day balances.
 *
 * **Scope decision, documented rather than silently skipped**: the
 * discount report covers item-level discounts only. A bill-level
 * (order-level) discount's minor-unit effect can only be recovered by
 * recomputing the order's entire non-voided, already-item-discounted
 * subtotal (the same calculation `DiscountsService.applyBillDiscount`
 * does at apply time) and re-applying the stored discount config against
 * it — real money math, but meaningfully more involved than every other
 * figure in this "basic" report, which are all either already-stored
 * totals or a single self-contained per-item calculation. Left for
 * whichever later reporting task actually needs it.
 *
 * **A second documented approximation**: the discount report windows by
 * `order_items.updatedAt`, since there's no dedicated "discount applied
 * at" timestamp on that row (unlike voids, which do have their own
 * `voidedAt`) — an item updated for an unrelated reason on a different day
 * after being discounted could in principle land in the wrong day's
 * report. Acceptable for a pilot report, not for a financial reconciliation.
 */
@Injectable()
export class SalesReportsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getDailySummary(params: { restaurantId: string; branchId: string; businessDate: string }): Promise<DailySalesSummary> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const { start, end } = await this.businessDayRange(tx, params.branchId, params.businessDate);

      const rows = await tx
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.branchId, params.branchId), gte(schema.invoices.createdAt, start), lt(schema.invoices.createdAt, end)));

      const currency = rows[0]?.currency ?? FALLBACK_CURRENCY;
      const totals = rows.reduce(
        (acc, row) => ({
          subtotalMinor: acc.subtotalMinor + row.subtotalMinor,
          taxMinor: acc.taxMinor + row.taxMinor,
          serviceChargeMinor: acc.serviceChargeMinor + row.serviceChargeMinor,
          grossSalesMinor: acc.grossSalesMinor + row.totalMinor,
        }),
        { subtotalMinor: 0n, taxMinor: 0n, serviceChargeMinor: 0n, grossSalesMinor: 0n },
      );

      return { businessDate: params.businessDate, currency, orderCount: rows.length, ...totals };
    });
  }

  async getPaymentBreakdown(params: { restaurantId: string; branchId: string; businessDate: string }): Promise<PaymentBreakdown> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const { start, end } = await this.businessDayRange(tx, params.branchId, params.businessDate);

      const rows = await tx
        .select()
        .from(schema.payments)
        .where(and(eq(schema.payments.branchId, params.branchId), gte(schema.payments.createdAt, start), lt(schema.payments.createdAt, end)));

      const currency = rows[0]?.currency ?? FALLBACK_CURRENCY;
      const byMethod = Object.fromEntries(ALL_METHODS.map((method) => [method, 0n])) as Record<PaymentMethod, bigint>;
      let tipsMinor = 0n;
      let totalMinor = 0n;
      for (const row of rows) {
        byMethod[row.method] += row.amountMinor;
        tipsMinor += row.tipMinor;
        totalMinor += row.amountMinor;
      }

      return { businessDate: params.businessDate, currency, byMethod, tipsMinor, totalMinor };
    });
  }

  async getVoidReport(params: { restaurantId: string; branchId: string; businessDate: string }): Promise<VoidReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const { start, end } = await this.businessDayRange(tx, params.branchId, params.businessDate);

      const orderIdsInBranch = await this.orderIdsForBranch(tx, params.branchId);
      if (orderIdsInBranch.length === 0) return { businessDate: params.businessDate, currency: FALLBACK_CURRENCY, entries: [], totalValueMinor: 0n, countByReasonCode: {} };

      const itemRows = await tx
        .select()
        .from(schema.orderItems)
        .where(and(inArray(schema.orderItems.orderId, orderIdsInBranch), isNotNull(schema.orderItems.voidedAt), gte(schema.orderItems.voidedAt, start), lt(schema.orderItems.voidedAt, end)));

      const currency = itemRows[0]?.currency ?? FALLBACK_CURRENCY;
      const modifierRows = itemRows.length > 0 ? await tx.select().from(schema.orderItemModifiers).where(inArray(schema.orderItemModifiers.orderItemId, itemRows.map((i) => i.id))) : [];

      const entries: VoidReportEntry[] = itemRows.map((item) => {
        const base = multiply(money(item.unitPriceMinor, item.currency), item.quantity);
        const itemModifiers = modifierRows.filter((m) => m.orderItemId === item.id);
        const modifiersTotal = itemModifiers.length > 0 ? sum(itemModifiers.map((m) => multiply(money(m.unitPriceMinor, m.currency), m.quantity))) : money(0n, item.currency);
        const value = add(base, modifiersTotal);
        return {
          itemId: item.id,
          orderId: item.orderId,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          valueMinor: value.amountMinor,
          reasonCode: item.voidReasonCode,
          voidedByUserId: item.voidedByUserId!,
          voidApprovedByUserId: item.voidApprovedByUserId,
          voidedAt: item.voidedAt!,
        };
      });

      const countByReasonCode: Record<string, number> = {};
      let totalValueMinor = 0n;
      for (const entry of entries) {
        totalValueMinor += entry.valueMinor;
        const key = entry.reasonCode ?? "unspecified";
        countByReasonCode[key] = (countByReasonCode[key] ?? 0) + 1;
      }

      return { businessDate: params.businessDate, currency, entries, totalValueMinor, countByReasonCode };
    });
  }

  async getDiscountReport(params: { restaurantId: string; branchId: string; businessDate: string }): Promise<DiscountReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const { start, end } = await this.businessDayRange(tx, params.branchId, params.businessDate);

      const orderIdsInBranch = await this.orderIdsForBranch(tx, params.branchId);
      if (orderIdsInBranch.length === 0) return { businessDate: params.businessDate, currency: FALLBACK_CURRENCY, entries: [], totalDiscountMinor: 0n, countByReasonCode: {} };

      const itemRows = await tx
        .select()
        .from(schema.orderItems)
        .where(
          and(
            inArray(schema.orderItems.orderId, orderIdsInBranch),
            isNull(schema.orderItems.voidedAt),
            gte(schema.orderItems.updatedAt, start),
            lt(schema.orderItems.updatedAt, end),
          ),
        );
      const discountedItems = itemRows.filter((item) => item.discountPercentBasisPoints !== null || item.discountAmountMinor !== null);

      const currency = discountedItems[0]?.currency ?? FALLBACK_CURRENCY;
      const modifierRows =
        discountedItems.length > 0 ? await tx.select().from(schema.orderItemModifiers).where(inArray(schema.orderItemModifiers.orderItemId, discountedItems.map((i) => i.id))) : [];

      const entries: DiscountReportEntry[] = discountedItems.map((item) => {
        const base = multiply(money(item.unitPriceMinor, item.currency), item.quantity);
        const itemModifiers = modifierRows.filter((m) => m.orderItemId === item.id);
        const modifiersTotal = itemModifiers.length > 0 ? sum(itemModifiers.map((m) => multiply(money(m.unitPriceMinor, m.currency), m.quantity))) : money(0n, item.currency);
        const lineTotal = add(base, modifiersTotal);

        const discountMinor =
          item.discountPercentBasisPoints !== null
            ? applyPercentageDiscount(lineTotal, item.discountPercentBasisPoints).discount.amountMinor
            : applyFixedDiscount(lineTotal, money(item.discountAmountMinor!, lineTotal.currency)).discount.amountMinor;

        return { itemId: item.id, orderId: item.orderId, discountMinor, reasonCode: item.discountReasonCode, approvedByUserId: item.discountApprovedByUserId };
      });

      const countByReasonCode: Record<string, number> = {};
      let totalDiscountMinor = 0n;
      for (const entry of entries) {
        totalDiscountMinor += entry.discountMinor;
        const key = entry.reasonCode ?? "unspecified";
        countByReasonCode[key] = (countByReasonCode[key] ?? 0) + 1;
      }

      return { businessDate: params.businessDate, currency, entries, totalDiscountMinor, countByReasonCode };
    });
  }

  async getRefundReport(params: { restaurantId: string; branchId: string; businessDate: string }): Promise<RefundReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const { start, end } = await this.businessDayRange(tx, params.branchId, params.businessDate);

      const rows = await tx
        .select()
        .from(schema.refunds)
        .where(and(eq(schema.refunds.branchId, params.branchId), gte(schema.refunds.createdAt, start), lt(schema.refunds.createdAt, end)));

      const currency = rows[0]?.currency ?? FALLBACK_CURRENCY;
      const entries: RefundReportEntry[] = rows.map((row) => ({
        refundId: row.id,
        invoiceId: row.invoiceId,
        amountMinor: row.amountMinor,
        reasonCode: row.reasonCode,
        approvedByUserId: row.approvedByUserId,
        createdAt: row.createdAt,
      }));

      const countByReasonCode: Record<string, number> = {};
      let totalRefundedMinor = 0n;
      for (const entry of entries) {
        totalRefundedMinor += entry.amountMinor;
        countByReasonCode[entry.reasonCode] = (countByReasonCode[entry.reasonCode] ?? 0) + 1;
      }

      return { businessDate: params.businessDate, currency, entries, totalRefundedMinor, countByReasonCode };
    });
  }

  private async orderIdsForBranch(tx: Database, branchId: string): Promise<string[]> {
    const rows = await tx.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.branchId, branchId));
    return rows.map((row) => row.id);
  }

  /** Converts a `businessDate` (YYYY-MM-DD, meaning local midnight in the
   * branch's own timezone — same "business day is local time, not server
   * UTC" concept as P2-30) into the half-open `[start, end)` UTC instant
   * range every query above filters by. */
  private async businessDayRange(tx: Database, branchId: string, businessDate: string): Promise<{ start: Date; end: Date }> {
    const rows = await tx.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, branchId));
    const branch = rows[0];
    if (!branch) throw new NotFoundException(BRANCH_NOT_FOUND);

    return businessDateRangeToUtc(businessDate, businessDate, branch.timezone);
  }
}
