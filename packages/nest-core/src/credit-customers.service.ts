import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";

const DEFAULT_LIST_LIMIT = 20;

export interface CreditCustomerRecord {
  id: string;
  name: string;
  phone: string | null;
  creditLimitMinor: bigint;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCreditCustomerParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  phone?: string;
  creditLimitMinor?: bigint;
  currency: string;
}

export interface UpdateCreditCustomerParams {
  restaurantId: string;
  actorUserId: string;
  creditCustomerId: string;
  name?: string;
  phone?: string | null;
  creditLimitMinor?: bigint;
  isActive?: boolean;
}

export interface CreditLedgerEntryRecord {
  id: string;
  creditCustomerId: string;
  entryType: "charge" | "repayment";
  amountMinor: bigint;
  currency: string;
  invoiceId: string | null;
  note: string | null;
  actorUserId: string;
  createdAt: Date;
}

export interface CreditBalance {
  creditLimitMinor: bigint;
  balanceMinor: bigint;
  availableCreditMinor: bigint;
}

export interface ChargeCreditParams {
  restaurantId: string;
  actorUserId: string;
  creditCustomerId: string;
  amountMinor: bigint;
  invoiceId?: string;
  note?: string;
}

export interface RecordRepaymentParams {
  restaurantId: string;
  actorUserId: string;
  creditCustomerId: string;
  amountMinor: bigint;
  note?: string;
}

const CUSTOMER_NOT_FOUND = "Credit customer not found";
const CUSTOMER_INACTIVE = "this credit customer's account is deactivated";
const AMOUNT_MUST_BE_POSITIVE = "amountMinor must be greater than zero";
const AMOUNT_EXCEEDS_CREDIT_LIMIT = "amountMinor would push this customer's balance past their credit limit";
const AMOUNT_EXCEEDS_BALANCE_OWED = "amountMinor cannot exceed what this customer currently owes";

/** Plain JS/bigint sum, same reasoning as payments.service.ts's sumPaymentAmounts — row count per customer is always small. */
function sumAmounts(rows: Array<{ amountMinor: bigint }>): bigint {
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
}

/**
 * P2-25: a restaurant-scoped customer who can buy on credit, with an
 * append-only account ledger (rule 4 — same enforcement as invoices/
 * payments/refunds; UPDATE/DELETE revoked in app-role.ts). `chargeInvoice`
 * records that an amount (typically a just-generated invoice's total) is
 * now owed by the customer instead of being paid immediately — it is
 * deliberately independent of PaymentsService/invoice "remaining balance":
 * the sale itself is already recorded on the invoice regardless of how it's
 * collected (rule 6), and this ledger is purely the accounts-receivable
 * side of who owes the restaurant and why. No manager-PIN approval here,
 * unlike discounts/voids/refunds — a credit sale within the customer's own
 * configured limit is an ordinary POS action, not an escalation.
 */
@Injectable()
export class CreditCustomersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(params: CreateCreditCustomerParams): Promise<CreditCustomerRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.creditCustomers)
        .values({
          restaurantId: params.restaurantId,
          name: params.name,
          phone: params.phone ?? null,
          creditLimitMinor: params.creditLimitMinor ?? 0n,
          currency: params.currency,
        })
        .returning();
      const customer = rows[0];
      if (!customer) throw new Error("create: credit customer insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "credit_customer.created", targetType: "credit_customer", targetId: customer.id },
        tx,
      );
      return customer;
    });
  }

  async list(restaurantId: string): Promise<CreditCustomerRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.creditCustomers));
  }

  async get(restaurantId: string, creditCustomerId: string): Promise<CreditCustomerRecord> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const customer = await this.requireCustomer(tx, restaurantId, creditCustomerId);
      return customer;
    });
  }

  async update(params: UpdateCreditCustomerParams): Promise<CreditCustomerRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireCustomer(tx, params.restaurantId, params.creditCustomerId);

      const rows = await tx
        .update(schema.creditCustomers)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.phone !== undefined && { phone: params.phone }),
          ...(params.creditLimitMinor !== undefined && { creditLimitMinor: params.creditLimitMinor }),
          ...(params.isActive !== undefined && { isActive: params.isActive }),
          updatedAt: new Date(),
        })
        .where(eq(schema.creditCustomers.id, params.creditCustomerId))
        .returning();
      const customer = rows[0];
      if (!customer) throw new NotFoundException(CUSTOMER_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "credit_customer.updated", targetType: "credit_customer", targetId: customer.id },
        tx,
      );
      return customer;
    });
  }

  async getBalance(params: { restaurantId: string; creditCustomerId: string }): Promise<CreditBalance> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const customer = await this.requireCustomer(tx, params.restaurantId, params.creditCustomerId);
      const balanceMinor = await this.computeBalance(tx, params.creditCustomerId);
      return { creditLimitMinor: customer.creditLimitMinor, balanceMinor, availableCreditMinor: customer.creditLimitMinor - balanceMinor };
    });
  }

  async listLedger(params: { restaurantId: string; creditCustomerId: string; cursor?: string; limit?: number }): Promise<Page<CreditLedgerEntryRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.creditLedgerEntries)
        .where(
          and(
            eq(schema.creditLedgerEntries.creditCustomerId, params.creditCustomerId),
            eq(schema.creditLedgerEntries.restaurantId, params.restaurantId),
            seekCondition(schema.creditLedgerEntries.createdAt, schema.creditLedgerEntries.id, after),
          ),
        )
        .orderBy(desc(schema.creditLedgerEntries.createdAt), desc(schema.creditLedgerEntries.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }

  async chargeInvoice(params: ChargeCreditParams): Promise<CreditLedgerEntryRecord> {
    if (params.amountMinor <= 0n) throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      // Row-locked so two concurrent charges against the same customer can't
      // both read the same balance and both pass the limit check — same
      // SELECT ... FOR UPDATE convention as PaymentsService.record (P2-20).
      const customer = await this.requireCustomer(tx, params.restaurantId, params.creditCustomerId, true);
      if (!customer.isActive) throw new BadRequestException(CUSTOMER_INACTIVE);

      const balanceMinor = await this.computeBalance(tx, params.creditCustomerId);
      if (balanceMinor + params.amountMinor > customer.creditLimitMinor) throw new BadRequestException(AMOUNT_EXCEEDS_CREDIT_LIMIT);

      return this.insertEntry(tx, params.restaurantId, params.actorUserId, {
        creditCustomerId: params.creditCustomerId,
        entryType: "charge",
        amountMinor: params.amountMinor,
        currency: customer.currency,
        invoiceId: params.invoiceId ?? null,
        note: params.note ?? null,
      });
    });
  }

  async recordRepayment(params: RecordRepaymentParams): Promise<CreditLedgerEntryRecord> {
    if (params.amountMinor <= 0n) throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const customer = await this.requireCustomer(tx, params.restaurantId, params.creditCustomerId, true);
      const balanceMinor = await this.computeBalance(tx, params.creditCustomerId);
      if (params.amountMinor > balanceMinor) throw new BadRequestException(AMOUNT_EXCEEDS_BALANCE_OWED);

      return this.insertEntry(tx, params.restaurantId, params.actorUserId, {
        creditCustomerId: params.creditCustomerId,
        entryType: "repayment",
        amountMinor: params.amountMinor,
        currency: customer.currency,
        invoiceId: null,
        note: params.note ?? null,
      });
    });
  }

  private async insertEntry(
    tx: Database,
    restaurantId: string,
    actorUserId: string,
    entry: { creditCustomerId: string; entryType: "charge" | "repayment"; amountMinor: bigint; currency: string; invoiceId: string | null; note: string | null },
  ): Promise<CreditLedgerEntryRecord> {
    const rows = await tx
      .insert(schema.creditLedgerEntries)
      .values({ restaurantId, actorUserId, ...entry })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("insertEntry: credit ledger insert returned no row");

    await this.auditLogService.record(
      {
        restaurantId,
        actorUserId,
        action: entry.entryType === "charge" ? "credit_account.charged" : "credit_account.repaid",
        targetType: "credit_ledger_entry",
        targetId: row.id,
        metadata: { creditCustomerId: entry.creditCustomerId, amountMinor: entry.amountMinor.toString(), invoiceId: entry.invoiceId },
      },
      tx,
    );
    return row;
  }

  private async computeBalance(tx: Database, creditCustomerId: string): Promise<bigint> {
    const rows = await tx
      .select({ entryType: schema.creditLedgerEntries.entryType, amountMinor: schema.creditLedgerEntries.amountMinor })
      .from(schema.creditLedgerEntries)
      .where(eq(schema.creditLedgerEntries.creditCustomerId, creditCustomerId));
    const charged = sumAmounts(rows.filter((r) => r.entryType === "charge"));
    const repaid = sumAmounts(rows.filter((r) => r.entryType === "repayment"));
    return charged - repaid;
  }

  private async requireCustomer(tx: Database, restaurantId: string, creditCustomerId: string, forUpdate = false): Promise<CreditCustomerRecord> {
    const condition = and(eq(schema.creditCustomers.id, creditCustomerId), eq(schema.creditCustomers.restaurantId, restaurantId));
    const rows = forUpdate
      ? await tx.select().from(schema.creditCustomers).where(condition).for("update")
      : await tx.select().from(schema.creditCustomers).where(condition);
    const customer = rows[0];
    if (!customer) throw new NotFoundException(CUSTOMER_NOT_FOUND);
    return customer;
  }
}
