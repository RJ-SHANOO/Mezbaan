import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";

const DEFAULT_LIST_LIMIT = 20;

export interface SupplierLedgerEntryRecord {
  id: string;
  branchId: string;
  supplierId: string;
  entryType: "invoice" | "payment";
  amountMinor: bigint;
  currency: string;
  supplierInvoiceId: string | null;
  note: string | null;
  actorUserId: string;
  createdAt: Date;
}

export interface SupplierBalance {
  balanceMinor: bigint;
  currency: string | null;
}

export interface RecordInvoiceChargeParams {
  restaurantId: string;
  branchId: string;
  supplierId: string;
  actorUserId: string;
  amountMinor: bigint;
  currency: string;
  supplierInvoiceId: string;
}

export interface RecordSupplierPaymentParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  supplierId: string;
  amountMinor: bigint;
  currency: string;
  note?: string;
}

export interface ListSupplierLedgerParams {
  restaurantId: string;
  supplierId: string;
  cursor?: string;
  limit?: number;
}

const SUPPLIER_NOT_FOUND = "Supplier not found";
const AMOUNT_MUST_BE_POSITIVE = "amountMinor must be greater than zero";
const AMOUNT_EXCEEDS_BALANCE_OWED = "amountMinor cannot exceed what's currently owed to this supplier";

/** Plain JS/bigint sum, same reasoning as payments.service.ts's sumPaymentAmounts/CreditCustomersService's own — row count per supplier is always small. */
function sumAmounts(rows: Array<{ amountMinor: bigint }>): bigint {
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
}

/**
 * P3-25: the accounts-payable mirror of CreditCustomersService (P2-25) —
 * see supplier-ledger-entries.ts's own docs for the schema-level
 * reasoning. `recordInvoiceChargeInTx` is deliberately not exposed through
 * any controller — unlike a customer credit sale (genuinely optional,
 * CreditCustomersService.chargeInvoice is its own manual API action), every
 * recorded supplier invoice is automatically a payable, so the only
 * caller is SupplierInvoicesService.record, in the same transaction as
 * the invoice itself. `recordPayment` is the one manual, controller-facing
 * action — paying down the supplier's overall running balance, not tied
 * to a specific invoice, same as CreditCustomersService.recordRepayment.
 */
@Injectable()
export class SupplierLedgerService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Must be called with the same `tx` as the supplier invoice insert that caused this — never its own transaction. */
  async recordInvoiceChargeInTx(tx: Database, params: RecordInvoiceChargeParams): Promise<SupplierLedgerEntryRecord> {
    return this.insertEntry(tx, params.restaurantId, params.actorUserId, {
      branchId: params.branchId,
      supplierId: params.supplierId,
      entryType: "invoice",
      amountMinor: params.amountMinor,
      currency: params.currency,
      supplierInvoiceId: params.supplierInvoiceId,
      note: null,
    });
  }

  async recordPayment(params: RecordSupplierPaymentParams): Promise<SupplierLedgerEntryRecord> {
    if (params.amountMinor <= 0n) throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const supplierRows = await tx.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.id, params.supplierId));
      if (supplierRows.length === 0) throw new NotFoundException(SUPPLIER_NOT_FOUND);

      const balanceMinor = await this.computeBalance(tx, params.supplierId);
      if (params.amountMinor > balanceMinor) throw new BadRequestException(AMOUNT_EXCEEDS_BALANCE_OWED);

      return this.insertEntry(tx, params.restaurantId, params.actorUserId, {
        branchId: params.branchId,
        supplierId: params.supplierId,
        entryType: "payment",
        amountMinor: params.amountMinor,
        currency: params.currency,
        supplierInvoiceId: null,
        note: params.note ?? null,
      });
    });
  }

  async getBalance(params: { restaurantId: string; supplierId: string }): Promise<SupplierBalance> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const supplierRows = await tx.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.id, params.supplierId));
      if (supplierRows.length === 0) throw new NotFoundException(SUPPLIER_NOT_FOUND);

      const entries = await tx
        .select({ currency: schema.supplierLedgerEntries.currency })
        .from(schema.supplierLedgerEntries)
        .where(eq(schema.supplierLedgerEntries.supplierId, params.supplierId))
        .limit(1);
      const balanceMinor = await this.computeBalance(tx, params.supplierId);
      return { balanceMinor, currency: entries[0]?.currency ?? null };
    });
  }

  async listLedger(params: ListSupplierLedgerParams): Promise<Page<SupplierLedgerEntryRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.supplierLedgerEntries)
        .where(
          and(
            eq(schema.supplierLedgerEntries.supplierId, params.supplierId),
            eq(schema.supplierLedgerEntries.restaurantId, params.restaurantId),
            seekCondition(schema.supplierLedgerEntries.createdAt, schema.supplierLedgerEntries.id, after),
          ),
        )
        .orderBy(desc(schema.supplierLedgerEntries.createdAt), desc(schema.supplierLedgerEntries.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }

  private async insertEntry(
    tx: Database,
    restaurantId: string,
    actorUserId: string,
    entry: { branchId: string; supplierId: string; entryType: "invoice" | "payment"; amountMinor: bigint; currency: string; supplierInvoiceId: string | null; note: string | null },
  ): Promise<SupplierLedgerEntryRecord> {
    const rows = await tx
      .insert(schema.supplierLedgerEntries)
      .values({ restaurantId, actorUserId, ...entry })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("insertEntry: supplier ledger insert returned no row");

    await this.auditLogService.record(
      {
        restaurantId,
        branchId: entry.branchId,
        actorUserId,
        action: entry.entryType === "invoice" ? "supplier_ledger.invoice_charged" : "supplier_ledger.payment_recorded",
        targetType: "supplier_ledger_entry",
        targetId: row.id,
        metadata: { supplierId: entry.supplierId, amountMinor: entry.amountMinor.toString(), supplierInvoiceId: entry.supplierInvoiceId },
      },
      tx,
    );
    return row;
  }

  private async computeBalance(tx: Database, supplierId: string): Promise<bigint> {
    const rows = await tx
      .select({ entryType: schema.supplierLedgerEntries.entryType, amountMinor: schema.supplierLedgerEntries.amountMinor })
      .from(schema.supplierLedgerEntries)
      .where(eq(schema.supplierLedgerEntries.supplierId, supplierId));
    const invoiced = sumAmounts(rows.filter((r) => r.entryType === "invoice"));
    const paid = sumAmounts(rows.filter((r) => r.entryType === "payment"));
    return invoiced - paid;
  }
}
