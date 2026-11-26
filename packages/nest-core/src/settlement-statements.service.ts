import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type SettlementStatementRecord = typeof schema.settlementStatements.$inferSelect;
export type SettlementPaymentRecord = typeof schema.settlementPayments.$inferSelect;

export interface CreateStatementForRunParams {
  restaurantId: string;
  commissionRunId: string;
  periodStart: Date;
  periodEnd: Date;
  totalAmountMinor: bigint;
  currency: string;
}

export interface SettlementBalance {
  totalAmountMinor: bigint;
  paidAmountMinor: bigint;
  remainingAmountMinor: bigint;
  currency: string;
}

export interface RecordSettlementPaymentParams {
  restaurantId: string;
  statementId: string;
  actorUserId: string;
  amountMinor: bigint;
  currency: string;
  reference?: string;
}

const STATEMENT_NOT_FOUND = "Settlement statement not found";
const AMOUNT_MUST_BE_POSITIVE = "amountMinor must be greater than zero";
const CURRENCY_MISMATCH = "currency does not match the statement's own currency";
const STATEMENT_ALREADY_SETTLED = "this settlement statement has already been paid in full";
const AMOUNT_EXCEEDS_BALANCE = "amountMinor cannot exceed the statement's remaining balance";

/** Plain JS/bigint sum, same reasoning as payments.service.ts's sumPaymentAmounts — the row count per statement is always small. */
function sumAmounts(rows: Array<{ amountMinor: bigint }>): bigint {
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
}

/**
 * P3-38: settlement statements (the restaurant-facing document for one
 * commission_runs row) and the payments recorded against them — see
 * settlement-statements.ts/settlement-payments.ts for the full design.
 */
@Injectable()
export class SettlementStatementsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Called by CommissionRunService inside its own transaction, right
   * after inserting the commission_runs row — never called standalone.
   * Idempotent the same way the run itself is: onConflictDoNothing against
   * the unique commissionRunId index, returning the existing row if one
   * already exists (it never should, given the run itself is idempotent,
   * but this makes the 1:1 invariant airtight rather than assumed). */
  async createForRunInTx(tx: Database, params: CreateStatementForRunParams): Promise<SettlementStatementRecord> {
    const rows = await tx
      .insert(schema.settlementStatements)
      .values({
        restaurantId: params.restaurantId,
        commissionRunId: params.commissionRunId,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        totalAmountMinor: params.totalAmountMinor,
        currency: params.currency,
      })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return rows[0];

    const existingRows = await tx.select().from(schema.settlementStatements).where(eq(schema.settlementStatements.commissionRunId, params.commissionRunId));
    const existing = existingRows[0];
    if (!existing) throw new Error("createForRunInTx: conflict but no existing row found");
    return existing;
  }

  /** P3-42: the set-based sibling of `createForRunInTx` — one bulk insert
   * for every run CommissionRunService just created in a single period,
   * instead of one insert per currency. Same idempotency guarantee: a
   * commissionRunId that somehow already had a statement (shouldn't
   * happen — every run passed in here was just freshly inserted in this
   * same transaction) is re-selected rather than silently dropped. */
  async createManyForRunsInTx(tx: Database, paramsList: CreateStatementForRunParams[]): Promise<SettlementStatementRecord[]> {
    if (paramsList.length === 0) return [];

    const rows = await tx
      .insert(schema.settlementStatements)
      .values(
        paramsList.map((params) => ({
          restaurantId: params.restaurantId,
          commissionRunId: params.commissionRunId,
          periodStart: params.periodStart,
          periodEnd: params.periodEnd,
          totalAmountMinor: params.totalAmountMinor,
          currency: params.currency,
        })),
      )
      .onConflictDoNothing()
      .returning();
    if (rows.length === paramsList.length) return rows;

    const foundRunIds = new Set(rows.map((row) => row.commissionRunId));
    const missingRunIds = paramsList.map((params) => params.commissionRunId).filter((id) => !foundRunIds.has(id));
    const existingRows = missingRunIds.length === 0 ? [] : await tx.select().from(schema.settlementStatements).where(inArray(schema.settlementStatements.commissionRunId, missingRunIds));
    return [...rows, ...existingRows];
  }

  /** Filters by restaurantId explicitly (rule 2) rather than leaving it to
   * RLS alone — true for both of these, but it only matters once
   * isSuperAdmin is true: that bypasses RLS's own tenant filtering
   * entirely, so without this WHERE clause a super-admin lookup for
   * restaurant A would return every restaurant's statements, not just
   * A's. */
  async listForRestaurant(restaurantId: string): Promise<SettlementStatementRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.settlementStatements).where(eq(schema.settlementStatements.restaurantId, restaurantId)));
  }

  async listForRestaurantAsSuperAdmin(restaurantId: string): Promise<SettlementStatementRecord[]> {
    return withTenant(this.db, { restaurantId, isSuperAdmin: true }, (tx) => tx.select().from(schema.settlementStatements).where(eq(schema.settlementStatements.restaurantId, restaurantId)));
  }

  async getBalance(params: { restaurantId: string; statementId: string; asSuperAdmin?: boolean }): Promise<SettlementBalance> {
    return withTenant(this.db, { restaurantId: params.restaurantId, isSuperAdmin: params.asSuperAdmin }, async (tx) => {
      const statement = await this.requireStatement(tx, params.restaurantId, params.statementId);
      return this.computeBalance(tx, statement);
    });
  }

  /** `requireStatement` (not a bare WHERE on settlementStatementId alone)
   * is what actually confirms this statement belongs to params.restaurantId
   * — same reasoning as listForRestaurantAsSuperAdmin above: once
   * asSuperAdmin bypasses RLS, nothing else here would catch a caller
   * passing a statementId that belongs to a different restaurant. */
  async listPayments(params: { restaurantId: string; statementId: string; asSuperAdmin?: boolean }): Promise<SettlementPaymentRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId, isSuperAdmin: params.asSuperAdmin }, async (tx) => {
      const statement = await this.requireStatement(tx, params.restaurantId, params.statementId);
      return tx.select().from(schema.settlementPayments).where(eq(schema.settlementPayments.settlementStatementId, statement.id));
    });
  }

  /** Always a super-admin action — platform ops recording that the
   * restaurant actually paid, after receiving the money outside this
   * system entirely (a bank transfer, typically). */
  async recordPayment(params: RecordSettlementPaymentParams): Promise<SettlementPaymentRecord> {
    if (params.amountMinor <= 0n) throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId, isSuperAdmin: true }, async (tx) => {
      // Advisory lock, not SELECT ... FOR UPDATE: settlement_statements is
      // append-only (rule 4), and Postgres requires the UPDATE privilege to
      // take a row lock via FOR UPDATE even though nothing here updates the
      // row — same reasoning as PaymentsService.record (P2-20).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${params.statementId}))`);

      const statement = await this.requireStatement(tx, params.restaurantId, params.statementId);
      if (params.currency !== statement.currency) throw new BadRequestException(CURRENCY_MISMATCH);

      const balance = await this.computeBalance(tx, statement);
      if (balance.remainingAmountMinor <= 0n) throw new BadRequestException(STATEMENT_ALREADY_SETTLED);
      if (params.amountMinor > balance.remainingAmountMinor) throw new BadRequestException(AMOUNT_EXCEEDS_BALANCE);

      const rows = await tx
        .insert(schema.settlementPayments)
        .values({
          restaurantId: params.restaurantId,
          settlementStatementId: params.statementId,
          amountMinor: params.amountMinor,
          currency: params.currency,
          reference: params.reference ?? null,
          recordedByUserId: params.actorUserId,
        })
        .returning();
      const payment = rows[0];
      if (!payment) throw new Error("recordPayment: insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "settlement_payment.recorded",
          targetType: "settlement_payment",
          targetId: payment.id,
          metadata: { statementId: params.statementId, amountMinor: payment.amountMinor.toString(), reference: params.reference ?? null },
        },
        tx,
      );

      return payment;
    });
  }

  private async requireStatement(tx: Database, restaurantId: string, statementId: string): Promise<SettlementStatementRecord> {
    const rows = await tx
      .select()
      .from(schema.settlementStatements)
      .where(and(eq(schema.settlementStatements.id, statementId), eq(schema.settlementStatements.restaurantId, restaurantId)));
    const statement = rows[0];
    if (!statement) throw new NotFoundException(STATEMENT_NOT_FOUND);
    return statement;
  }

  private async computeBalance(tx: Database, statement: SettlementStatementRecord): Promise<SettlementBalance> {
    const paymentRows = await tx.select({ amountMinor: schema.settlementPayments.amountMinor }).from(schema.settlementPayments).where(eq(schema.settlementPayments.settlementStatementId, statement.id));
    const paidAmountMinor = sumAmounts(paymentRows);
    return { totalAmountMinor: statement.totalAmountMinor, paidAmountMinor, remainingAmountMinor: statement.totalAmountMinor - paidAmountMinor, currency: statement.currency };
  }
}
