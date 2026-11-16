import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type CashMovementDirection = "in" | "out";
export type CashDrawerOpenTrigger = "no_sale" | "cash_in" | "cash_out" | "shift_open" | "shift_close" | "manual";

export interface CashMovementReasonCodeRecord {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetCashMovementReasonCodeParams {
  restaurantId: string;
  actorUserId: string;
  code: string;
  label: string;
  isActive?: boolean;
}

export interface CashMovementRecord {
  id: string;
  shiftId: string;
  direction: CashMovementDirection;
  amountMinor: bigint;
  currency: string;
  reasonCode: string;
  note: string | null;
  actorUserId: string;
  createdAt: Date;
}

export interface CashDrawerOpenEventRecord {
  id: string;
  shiftId: string;
  trigger: CashDrawerOpenTrigger;
  actorUserId: string;
  createdAt: Date;
}

export interface RecordCashMovementParams {
  restaurantId: string;
  actorUserId: string;
  shiftId: string;
  amountMinor: bigint;
  reasonCode: string;
  note?: string;
}

export interface LogDrawerOpenParams {
  restaurantId: string;
  actorUserId: string;
  shiftId: string;
  trigger: CashDrawerOpenTrigger;
}

const SHIFT_NOT_FOUND = "Shift not found";
const SHIFT_NOT_OPEN = "a cash movement can only be recorded against an open shift";
const AMOUNT_MUST_BE_POSITIVE = "amountMinor must be greater than zero";
const REASON_CODE_NOT_FOUND = "this cash movement reason code doesn't exist or is no longer active";

/**
 * P2-28: manual cash in/out against an open shift's drawer, each with a
 * restaurant-defined reason code (rule 6 — every manual drawer movement is
 * recorded, attributed and visible, same reasoning as discount/void/refund
 * reason codes), plus an append-only log of every time the drawer opened.
 * Both `cash_movements` and `cash_drawer_open_events` are append-only (rule
 * 4 — UPDATE/DELETE revoked in app-role.ts). Deliberately no balance check
 * against expected drawer cash here — reconciling counted cash against
 * opening float + sales + movements is P2-29's over/short job, not this
 * one's.
 */
@Injectable()
export class CashMovementsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async listReasonCodes(restaurantId: string): Promise<CashMovementReasonCodeRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.cashMovementReasonCodes));
  }

  async setReasonCode(params: SetCashMovementReasonCodeParams): Promise<CashMovementReasonCodeRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.cashMovementReasonCodes)
        .values({ restaurantId: params.restaurantId, code: params.code, label: params.label, isActive: params.isActive ?? true })
        .onConflictDoUpdate({
          target: [schema.cashMovementReasonCodes.restaurantId, schema.cashMovementReasonCodes.code],
          set: { label: params.label, isActive: params.isActive ?? true, updatedAt: new Date() },
        })
        .returning();
      const reasonCode = rows[0];
      if (!reasonCode) throw new Error("setReasonCode: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "cash_movement_reason_code.set", targetType: "cash_movement_reason_code", targetId: reasonCode.id, metadata: { code: params.code } },
        tx,
      );
      return reasonCode;
    });
  }

  async recordCashIn(params: RecordCashMovementParams): Promise<CashMovementRecord> {
    return this.recordMovement(params, "in");
  }

  async recordCashOut(params: RecordCashMovementParams): Promise<CashMovementRecord> {
    return this.recordMovement(params, "out");
  }

  async logDrawerOpen(params: LogDrawerOpenParams): Promise<CashDrawerOpenEventRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const shift = await this.requireShift(tx, params.shiftId);
      return this.insertDrawerOpenEvent(tx, params.restaurantId, params.actorUserId, shift.branchId, params.shiftId, params.trigger);
    });
  }

  async listMovementsForShift(params: { restaurantId: string; shiftId: string }): Promise<CashMovementRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) => tx.select().from(schema.cashMovements).where(eq(schema.cashMovements.shiftId, params.shiftId)));
  }

  async listDrawerOpenEventsForShift(params: { restaurantId: string; shiftId: string }): Promise<CashDrawerOpenEventRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) => tx.select().from(schema.cashDrawerOpenEvents).where(eq(schema.cashDrawerOpenEvents.shiftId, params.shiftId)));
  }

  private async recordMovement(params: RecordCashMovementParams, direction: CashMovementDirection): Promise<CashMovementRecord> {
    if (params.amountMinor <= 0n) throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const shift = await this.requireShift(tx, params.shiftId);
      await this.requireActiveReasonCode(tx, params.reasonCode);

      const rows = await tx
        .insert(schema.cashMovements)
        .values({
          restaurantId: params.restaurantId,
          branchId: shift.branchId,
          shiftId: params.shiftId,
          direction,
          amountMinor: params.amountMinor,
          currency: shift.currency,
          reasonCode: params.reasonCode,
          note: params.note ?? null,
          actorUserId: params.actorUserId,
        })
        .returning();
      const movement = rows[0];
      if (!movement) throw new Error("recordMovement: cash movement insert returned no row");

      // Moving physical cash implies the drawer opened — logged automatically
      // rather than requiring the caller to also call logDrawerOpen.
      await this.insertDrawerOpenEvent(tx, params.restaurantId, params.actorUserId, shift.branchId, params.shiftId, direction === "in" ? "cash_in" : "cash_out");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: direction === "in" ? "cash_movement.cash_in" : "cash_movement.cash_out",
          targetType: "cash_movement",
          targetId: movement.id,
          metadata: { shiftId: params.shiftId, amountMinor: movement.amountMinor.toString(), reasonCode: params.reasonCode },
        },
        tx,
      );
      return movement;
    });
  }

  private async insertDrawerOpenEvent(
    tx: Database,
    restaurantId: string,
    actorUserId: string,
    branchId: string,
    shiftId: string,
    trigger: CashDrawerOpenTrigger,
  ): Promise<CashDrawerOpenEventRecord> {
    const rows = await tx.insert(schema.cashDrawerOpenEvents).values({ restaurantId, branchId, shiftId, trigger, actorUserId }).returning();
    const event = rows[0];
    if (!event) throw new Error("insertDrawerOpenEvent: insert returned no row");

    await this.auditLogService.record(
      { restaurantId, actorUserId, action: "cash_drawer.opened", targetType: "cash_drawer_open_event", targetId: event.id, metadata: { shiftId, trigger } },
      tx,
    );
    return event;
  }

  private async requireShift(tx: Database, shiftId: string): Promise<{ branchId: string; currency: string }> {
    const rows = await tx.select({ status: schema.shifts.status, branchId: schema.shifts.branchId, currency: schema.shifts.currency }).from(schema.shifts).where(eq(schema.shifts.id, shiftId));
    const shift = rows[0];
    if (!shift) throw new NotFoundException(SHIFT_NOT_FOUND);
    if (shift.status !== "open") throw new BadRequestException(SHIFT_NOT_OPEN);
    return shift;
  }

  private async requireActiveReasonCode(tx: Database, code: string): Promise<void> {
    const rows = await tx.select({ isActive: schema.cashMovementReasonCodes.isActive }).from(schema.cashMovementReasonCodes).where(eq(schema.cashMovementReasonCodes.code, code));
    if (!rows[0] || !rows[0].isActive) throw new BadRequestException(REASON_CODE_NOT_FOUND);
  }
}
