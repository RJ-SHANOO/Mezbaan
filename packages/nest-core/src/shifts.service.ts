import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { money, multiply, sum } from "@mezbaan/domain";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";

const DEFAULT_LIST_LIMIT = 20;

export interface DenominationCount {
  denominationMinor: bigint;
  count: number;
}

export interface ShiftRecord {
  id: string;
  branchId: string;
  deviceId: string;
  openedByUserId: string;
  openingFloatMinor: bigint;
  openingNote: string | null;
  currency: string;
  status: "open" | "closed";
  openedAt: Date;
  closedByUserId: string | null;
  closedAt: Date | null;
  closingCashCounts: DenominationCount[] | null;
  countedCashMinor: bigint | null;
  closingNote: string | null;
}

export interface OpenShiftParams {
  restaurantId: string;
  actorUserId: string;
  deviceId: string;
  openingFloatMinor: bigint;
  currency: string;
  openingNote?: string;
}

export interface CloseShiftParams {
  restaurantId: string;
  actorUserId: string;
  shiftId: string;
  denominationCounts: DenominationCount[];
  closingNote?: string;
}

const DEVICE_NOT_FOUND = "Device not found";
const DEVICE_REVOKED = "this device has been revoked and can't open a shift";
const SHIFT_ALREADY_OPEN = "this device already has an open shift — close it before opening a new one";
const SHIFT_NOT_FOUND = "Shift not found";
const SHIFT_NOT_OPEN = "this shift is already closed";
const FLOAT_MUST_NOT_BE_NEGATIVE = "openingFloatMinor must not be negative";
const DENOMINATIONS_REQUIRED = "denominationCounts must include at least one entry";
const INVALID_DENOMINATION = "each denomination's amount must be positive and its count must not be negative";

/**
 * P2-27: a cashier's shift at a till (device) — opened with a lump opening
 * float (rule 5: bigint minor units), closed by counting the cash drawer
 * denomination by denomination. `close` is purely a count-and-record step;
 * it deliberately computes no over/short figure and no X/Z report — those
 * need P2-28's cash in/out ledger too and arrive with P2-29.
 */
@Injectable()
export class ShiftsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async open(params: OpenShiftParams): Promise<ShiftRecord> {
    if (params.openingFloatMinor < 0n) throw new BadRequestException(FLOAT_MUST_NOT_BE_NEGATIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const deviceRows = await tx
        .select()
        .from(schema.devices)
        .where(and(eq(schema.devices.id, params.deviceId), eq(schema.devices.restaurantId, params.restaurantId)));
      const device = deviceRows[0];
      if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);
      if (device.status === "revoked") throw new BadRequestException(DEVICE_REVOKED);

      // App-level pre-check for a clean error message; shifts_device_open_idx
      // (a partial unique index on deviceId WHERE status = 'open') is the real
      // guard against two concurrent opens racing past this check — same
      // two-layer convention as P2-16's table-occupancy index.
      const existingShifts = await tx.select({ status: schema.shifts.status }).from(schema.shifts).where(eq(schema.shifts.deviceId, params.deviceId));
      if (existingShifts.some((row) => row.status === "open")) throw new BadRequestException(SHIFT_ALREADY_OPEN);

      const rows = await tx
        .insert(schema.shifts)
        .values({
          restaurantId: params.restaurantId,
          branchId: device.branchId,
          deviceId: params.deviceId,
          openedByUserId: params.actorUserId,
          openingFloatMinor: params.openingFloatMinor,
          openingNote: params.openingNote ?? null,
          currency: params.currency,
        })
        .returning();
      const shift = rows[0];
      if (!shift) throw new Error("open: shift insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "shift.opened", targetType: "shift", targetId: shift.id, metadata: { deviceId: params.deviceId, openingFloatMinor: shift.openingFloatMinor.toString() } },
        tx,
      );
      return this.toRecord(shift);
    });
  }

  async close(params: CloseShiftParams): Promise<ShiftRecord> {
    if (params.denominationCounts.length === 0) throw new BadRequestException(DENOMINATIONS_REQUIRED);
    for (const entry of params.denominationCounts) {
      if (entry.denominationMinor <= 0n || entry.count < 0) throw new BadRequestException(INVALID_DENOMINATION);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.shifts).where(eq(schema.shifts.id, params.shiftId)).for("update");
      const shift = rows[0];
      if (!shift) throw new NotFoundException(SHIFT_NOT_FOUND);
      if (shift.status !== "open") throw new BadRequestException(SHIFT_NOT_OPEN);

      const countedCash = sum(params.denominationCounts.map((entry) => multiply(money(entry.denominationMinor, shift.currency), entry.count)));

      const updatedRows = await tx
        .update(schema.shifts)
        .set({
          status: "closed",
          closedByUserId: params.actorUserId,
          closedAt: new Date(),
          closingCashCounts: params.denominationCounts.map((entry) => ({ denominationMinor: entry.denominationMinor.toString(), count: entry.count })),
          countedCashMinor: countedCash.amountMinor,
          closingNote: params.closingNote ?? null,
        })
        .where(eq(schema.shifts.id, params.shiftId))
        .returning();
      const updated = updatedRows[0];
      if (!updated) throw new Error("close: shift update returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "shift.closed", targetType: "shift", targetId: updated.id, metadata: { countedCashMinor: countedCash.amountMinor.toString() } },
        tx,
      );
      return this.toRecord(updated);
    });
  }

  async get(restaurantId: string, shiftId: string): Promise<ShiftRecord> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.shifts).where(eq(schema.shifts.id, shiftId));
      const shift = rows[0];
      if (!shift) throw new NotFoundException(SHIFT_NOT_FOUND);
      return this.toRecord(shift);
    });
  }

  async getOpenShiftForDevice(restaurantId: string, deviceId: string): Promise<ShiftRecord | null> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.shifts).where(eq(schema.shifts.deviceId, deviceId));
      const open = rows.find((row) => row.status === "open");
      return open ? this.toRecord(open) : null;
    });
  }

  async listForBranch(restaurantId: string, branchId: string, cursor?: string, limit = DEFAULT_LIST_LIMIT): Promise<Page<ShiftRecord>> {
    const after: CursorFields | undefined = cursor !== undefined ? decodeCursor(cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.shifts)
        .where(and(eq(schema.shifts.branchId, branchId), seekCondition(schema.shifts.openedAt, schema.shifts.id, after)))
        .orderBy(desc(schema.shifts.openedAt), desc(schema.shifts.id))
        .limit(limit + 1),
    );
    const page = toPage(rows, limit, (row) => ({ createdAt: row.openedAt, id: row.id }));
    return { items: page.items.map((row) => this.toRecord(row)), nextCursor: page.nextCursor };
  }

  private toRecord(row: typeof schema.shifts.$inferSelect): ShiftRecord {
    return {
      ...row,
      closingCashCounts: row.closingCashCounts
        ? (row.closingCashCounts as Array<{ denominationMinor: string; count: number }>).map((entry) => ({ denominationMinor: BigInt(entry.denominationMinor), count: entry.count }))
        : null,
    };
  }
}
