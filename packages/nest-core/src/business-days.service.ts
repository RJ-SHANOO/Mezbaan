import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type BusinessDayStatus = "open" | "closed";

export interface BusinessDayRecord {
  id: string;
  branchId: string;
  businessDate: string;
  status: BusinessDayStatus;
  closedByUserId: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CloseBusinessDayParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  /** Defaults to the branch's own current local date if omitted. */
  businessDate?: string;
}

const BRANCH_NOT_FOUND = "Branch not found";
const DAY_ALREADY_CLOSED = "this branch's business day is already closed";
const DAY_CLOSED_FOR_SALES = "this branch's business day is closed — no new sales can be opened until the next business day";

/**
 * P2-30: closing a branch's business day blocks NEW sales for that day
 * without touching anything already recorded (rule 6 — closing never
 * hides or removes a sale). A day with no row at all is implicitly open;
 * only `close` ever writes one, so there's no separate "open" action.
 *
 * `requireOpenForSale` is the gate `OrdersService.create` calls before
 * opening a new order. It defaults to checking "today" in the branch's own
 * timezone (a business day is a local-time concept, not server UTC) — but
 * callers can pass an explicit `asOfBusinessDate` to check a *different*
 * day's status instead. That hook exists specifically for "without losing
 * offline sales": a synced operation that actually happened on an
 * already-closed day should be checked against ITS OWN original date, not
 * "today," so a terminal that was offline when the day closed can still
 * have its already-completed sale accepted once it reconnects. No real
 * sync-replay caller exists yet to pass that override (per P2-12's notes,
 * there's still no real offline-terminal-to-server order flow wired up) —
 * this only documents and prepares the hook for when one exists, same
 * "backend-only, integration deferred" pattern as this phase's other
 * catalog/pricing tasks.
 */
@Injectable()
export class BusinessDaysService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async requireOpenForSale(restaurantId: string, branchId: string, asOfBusinessDate?: string): Promise<void> {
    await withTenant(this.db, { restaurantId }, async (tx) => {
      const branch = await this.requireBranch(tx, branchId);
      const businessDate = asOfBusinessDate ?? this.todayFor(branch.timezone);

      const rows = await tx.select({ status: schema.businessDays.status }).from(schema.businessDays).where(and(eq(schema.businessDays.branchId, branchId), eq(schema.businessDays.businessDate, businessDate)));
      if (rows[0]?.status === "closed") throw new BadRequestException(DAY_CLOSED_FOR_SALES);
    });
  }

  async close(params: CloseBusinessDayParams): Promise<BusinessDayRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branch = await this.requireBranch(tx, params.branchId);
      const businessDate = params.businessDate ?? this.todayFor(branch.timezone);

      const existingRows = await tx
        .select()
        .from(schema.businessDays)
        .where(and(eq(schema.businessDays.branchId, params.branchId), eq(schema.businessDays.businessDate, businessDate)))
        .for("update");
      const existing = existingRows[0];
      if (existing?.status === "closed") throw new BadRequestException(DAY_ALREADY_CLOSED);

      const closedAt = new Date();
      let row: typeof schema.businessDays.$inferSelect | undefined;
      if (existing) {
        const updatedRows = await tx
          .update(schema.businessDays)
          .set({ status: "closed", closedByUserId: params.actorUserId, closedAt, updatedAt: closedAt })
          .where(eq(schema.businessDays.id, existing.id))
          .returning();
        row = updatedRows[0];
      } else {
        const insertedRows = await tx
          .insert(schema.businessDays)
          .values({ restaurantId: params.restaurantId, branchId: params.branchId, businessDate, status: "closed", closedByUserId: params.actorUserId, closedAt })
          .returning();
        row = insertedRows[0];
      }
      if (!row) throw new Error("close: business day insert/update returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "business_day.closed", targetType: "business_day", targetId: row.id, metadata: { branchId: params.branchId, businessDate } },
        tx,
      );
      return row;
    });
  }

  async getStatus(params: { restaurantId: string; branchId: string; businessDate?: string }): Promise<{ businessDate: string; status: BusinessDayStatus }> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branch = await this.requireBranch(tx, params.branchId);
      const businessDate = params.businessDate ?? this.todayFor(branch.timezone);
      const rows = await tx.select({ status: schema.businessDays.status }).from(schema.businessDays).where(and(eq(schema.businessDays.branchId, params.branchId), eq(schema.businessDays.businessDate, businessDate)));
      return { businessDate, status: rows[0]?.status ?? "open" };
    });
  }

  async list(restaurantId: string, branchId: string): Promise<BusinessDayRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.businessDays).where(eq(schema.businessDays.branchId, branchId)));
  }

  private async requireBranch(tx: Database, branchId: string): Promise<{ timezone: string }> {
    const rows = await tx.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, branchId));
    const branch = rows[0];
    if (!branch) throw new NotFoundException(BRANCH_NOT_FOUND);
    return branch;
  }

  /** "Today" as a YYYY-MM-DD string in the branch's own timezone — a business day is local time, not server UTC. */
  private todayFor(timezone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    return `${year}-${month}-${day}`;
  }
}
