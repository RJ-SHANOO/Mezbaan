import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { allocate, money, type Money } from "@mezbaan/domain";
import { and, eq, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { OutboxService } from "./outbox.service.js";
import { PaymentMethodSettingsService, type PaymentMethod } from "./payment-method-settings.service.js";

export interface PaymentRecord {
  id: string;
  invoiceId: string;
  method: PaymentMethod;
  amountMinor: bigint;
  tipMinor: bigint;
  changeMinor: bigint;
  currency: string;
  actorUserId: string;
  createdAt: Date;
}

export interface InvoiceBalance {
  totalMinor: bigint;
  paidMinor: bigint;
  remainingMinor: bigint;
}

export interface RecordPaymentParams {
  restaurantId: string;
  invoiceId: string;
  actorUserId: string;
  method: PaymentMethod;
  amountMinor: bigint;
  tipMinor?: bigint;
  /** Cash only — what the customer physically handed over, if more than amountMinor. The server computes change, never the caller. */
  tenderedMinor?: bigint;
}

const INVOICE_NOT_FOUND = "Invoice not found";
const AMOUNT_MUST_BE_POSITIVE = "amountMinor must be greater than zero";
const TIP_MUST_NOT_BE_NEGATIVE = "tipMinor must not be negative";
const METHOD_DISABLED = "this payment method is not accepted by this restaurant";
const TENDERED_ONLY_FOR_CASH = "tenderedMinor is only valid for cash payments";
const TENDERED_LESS_THAN_AMOUNT = "tenderedMinor cannot be less than amountMinor";
const INVOICE_ALREADY_PAID = "this invoice has already been paid in full";
const AMOUNT_EXCEEDS_BALANCE = "amountMinor cannot exceed the invoice's remaining balance";
const PARTS_MUST_BE_POSITIVE = "parts must be a positive integer";

/** Plain JS/bigint sum rather than a SQL aggregate — the row count per invoice is always small (a handful of split payments, never a bulk scan), so there's no real cost to reading them and summing here, and it avoids any ambiguity in how a driver represents a SQL SUM() over a bigint column. */
async function sumPaymentAmounts(tx: Database, invoiceId: string): Promise<bigint> {
  const rows = await tx.select({ amountMinor: schema.payments.amountMinor }).from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
}

/**
 * P2-19/P2-20: records one tendered payment against an invoice (P2-18) —
 * cash, card, bank transfer or wallet, with an optional tip, and (cash only)
 * exact change. `record` is what actually turns "more than one payment row
 * per invoice" (allowed by the schema since P2-19) into a real split
 * payment: it locks the invoice row, sums every payment already recorded
 * against it, and rejects anything that would push the total past the
 * invoice's own total — the same SELECT ... FOR UPDATE convention P2-16
 * already uses to stop two concurrent writers from both reading a stale
 * balance and both succeeding.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly paymentMethodSettingsService: PaymentMethodSettingsService,
    // P3-34: optional for the same reason InvoicesService's is — every
    // existing test instantiating PaymentsService directly with 3
    // arguments still compiles unchanged. Without it, record() simply
    // doesn't enqueue a commission job.
    @Optional() private readonly outboxService?: OutboxService,
  ) {}

  async record(params: RecordPaymentParams): Promise<PaymentRecord> {
    if (params.amountMinor <= 0n) throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);
    const tipMinor = params.tipMinor ?? 0n;
    if (tipMinor < 0n) throw new BadRequestException(TIP_MUST_NOT_BE_NEGATIVE);
    if (params.tenderedMinor !== undefined) {
      if (params.method !== "cash") throw new BadRequestException(TENDERED_ONLY_FOR_CASH);
      if (params.tenderedMinor < params.amountMinor) throw new BadRequestException(TENDERED_LESS_THAN_AMOUNT);
    }

    const enabled = await this.paymentMethodSettingsService.isEnabled(params.restaurantId, params.method);
    if (!enabled) throw new BadRequestException(METHOD_DISABLED);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      // Locks the invoice for the rest of this transaction so two concurrent
      // split-payment calls against the same bill can't both read the same
      // "remaining" balance and both succeed — the second one waits, then
      // re-sums against what the first just committed. An advisory lock,
      // not SELECT ... FOR UPDATE: rule 4 revokes UPDATE on `invoices` at
      // the database level (it's append-only), and Postgres requires the
      // UPDATE privilege to take a row lock via FOR UPDATE even though
      // nothing here actually updates the row.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${params.invoiceId}))`);
      const invoiceRows = await tx
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, params.invoiceId), eq(schema.invoices.restaurantId, params.restaurantId)));
      const invoice = invoiceRows[0];
      if (!invoice) throw new NotFoundException(INVOICE_NOT_FOUND);

      const paidSoFar = await sumPaymentAmounts(tx, params.invoiceId);
      const remaining = invoice.totalMinor - paidSoFar;

      if (remaining <= 0n) throw new BadRequestException(INVOICE_ALREADY_PAID);
      if (params.amountMinor > remaining) throw new BadRequestException(AMOUNT_EXCEEDS_BALANCE);

      const changeMinor = params.tenderedMinor !== undefined ? params.tenderedMinor - params.amountMinor : 0n;

      const rows = await tx
        .insert(schema.payments)
        .values({
          restaurantId: params.restaurantId,
          branchId: invoice.branchId,
          invoiceId: params.invoiceId,
          method: params.method,
          amountMinor: params.amountMinor,
          tipMinor,
          changeMinor,
          currency: invoice.currency,
          actorUserId: params.actorUserId,
        })
        .returning();
      const payment = rows[0];
      if (!payment) throw new Error("record: payment insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "payment.recorded",
          targetType: "payment",
          targetId: payment.id,
          metadata: {
            invoiceId: params.invoiceId,
            method: params.method,
            amountMinor: payment.amountMinor.toString(),
            tipMinor: payment.tipMinor.toString(),
            changeMinor: payment.changeMinor.toString(),
          },
        },
        tx,
      );

      // P3-34: same transaction as the payment insert — if this commits, a
      // commission entry is guaranteed to eventually be processed; if the
      // transaction rolls back, no orphaned outbox row is left behind.
      await this.outboxService?.record(
        { restaurantId: params.restaurantId, aggregateType: "payment", aggregateId: payment.id, eventType: "payment.recorded", payload: { paymentId: payment.id } },
        tx,
      );

      return payment as PaymentRecord;
    });
  }

  async listForInvoice(params: { restaurantId: string; invoiceId: string }): Promise<PaymentRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, params.invoiceId));
      return rows as PaymentRecord[];
    });
  }

  /** P2-20: the running balance a split-payment flow checks before deciding the next method/amount. */
  async getBalance(params: { restaurantId: string; invoiceId: string }): Promise<InvoiceBalance> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const invoiceRows = await tx
        .select({ totalMinor: schema.invoices.totalMinor })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, params.invoiceId), eq(schema.invoices.restaurantId, params.restaurantId)));
      const invoice = invoiceRows[0];
      if (!invoice) throw new NotFoundException(INVOICE_NOT_FOUND);

      const paidMinor = await sumPaymentAmounts(tx, params.invoiceId);

      return { totalMinor: invoice.totalMinor, paidMinor, remainingMinor: invoice.totalMinor - paidMinor };
    });
  }

  /**
   * P2-21: "split into equal parts" — divides whatever is still owed into
   * `parts` amounts that sum back to it exactly, cents and all. Reuses
   * packages/domain's existing `allocate` (equal weights = an even split)
   * rather than hand-rolling remainder-cent logic again; this is purely a
   * suggestion for the cashier/UI to act on — actually collecting each
   * share still goes through the ordinary `record` above, one call per
   * person, same as any other split payment.
   */
  async suggestEqualSplit(params: { restaurantId: string; invoiceId: string; parts: number }): Promise<Money[]> {
    if (!Number.isInteger(params.parts) || params.parts <= 0) throw new BadRequestException(PARTS_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const invoiceRows = await tx
        .select({ totalMinor: schema.invoices.totalMinor, currency: schema.invoices.currency })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, params.invoiceId), eq(schema.invoices.restaurantId, params.restaurantId)));
      const invoice = invoiceRows[0];
      if (!invoice) throw new NotFoundException(INVOICE_NOT_FOUND);

      const paidMinor = await sumPaymentAmounts(tx, params.invoiceId);
      const remaining = money(invoice.totalMinor - paidMinor, invoice.currency);

      return allocate(remaining, Array.from({ length: params.parts }, () => 1));
    });
  }
}
