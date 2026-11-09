import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ComboSlotRecord {
  id: string;
  comboId: string;
  name: string;
  kind: "fixed" | "choice";
  minSelections: number;
  maxSelections: number | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateComboSlotParams {
  restaurantId: string;
  actorUserId: string;
  comboId: string;
  name: string;
  kind: "fixed" | "choice";
  minSelections?: number;
  maxSelections?: number;
  sortOrder?: number;
}

export interface UpdateComboSlotParams {
  restaurantId: string;
  slotId: string;
  actorUserId: string;
  name?: string;
  minSelections?: number;
  maxSelections?: number | null;
  sortOrder?: number;
}

const SLOT_NOT_FOUND = "Combo slot not found";
const COMBO_NOT_FOUND = "Combo not found";
const INVALID_SELECTION_RANGE = "maxSelections must be greater than or equal to minSelections";
const FIXED_SLOT_SELECTION_RANGE_FIXED = "a fixed slot always has exactly one selection (minSelections and maxSelections are both 1)";

/** Same reference pattern as ModifierGroupsService (P2-02), plus the
 * fixed-vs-choice distinction P2-03 asks for: a "fixed" slot's
 * minSelections/maxSelections are pinned to 1 regardless of what's passed —
 * there's no meaningful "choice count" for a slot that was never a choice. */
@Injectable()
export class ComboSlotsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, comboId: string): Promise<ComboSlotRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx.select().from(schema.comboSlots).where(eq(schema.comboSlots.comboId, comboId)).orderBy(asc(schema.comboSlots.sortOrder)),
    );
  }

  async create(params: CreateComboSlotParams): Promise<ComboSlotRecord> {
    const isFixed = params.kind === "fixed";
    const minSelections = isFixed ? 1 : params.minSelections ?? 1;
    const maxSelections = isFixed ? 1 : params.maxSelections;
    if (!isFixed) assertValidRange(minSelections, maxSelections);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const comboRows = await tx.select({ id: schema.combos.id }).from(schema.combos).where(eq(schema.combos.id, params.comboId));
      if (comboRows.length === 0) throw new NotFoundException(COMBO_NOT_FOUND);

      const rows = await tx
        .insert(schema.comboSlots)
        .values({
          restaurantId: params.restaurantId,
          comboId: params.comboId,
          name: params.name,
          kind: params.kind,
          minSelections,
          maxSelections: maxSelections ?? null,
          sortOrder: params.sortOrder ?? 0,
        })
        .returning();
      const slot = rows[0];
      if (!slot) throw new Error("create: combo slot insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "combo_slot.created", targetType: "combo_slot", targetId: slot.id },
        tx,
      );
      return slot;
    });
  }

  async update(params: UpdateComboSlotParams): Promise<ComboSlotRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.comboSlots).where(eq(schema.comboSlots.id, params.slotId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(SLOT_NOT_FOUND);

      const touchesSelectionRange = params.minSelections !== undefined || params.maxSelections !== undefined;
      if (existing.kind === "fixed" && touchesSelectionRange) {
        throw new BadRequestException(FIXED_SLOT_SELECTION_RANGE_FIXED);
      }
      if (existing.kind === "choice") {
        const nextMin = params.minSelections ?? existing.minSelections;
        const nextMax = params.maxSelections !== undefined ? params.maxSelections : existing.maxSelections;
        assertValidRange(nextMin, nextMax ?? undefined);
      }

      const rows = await tx
        .update(schema.comboSlots)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.minSelections !== undefined && { minSelections: params.minSelections }),
          ...(params.maxSelections !== undefined && { maxSelections: params.maxSelections }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          updatedAt: new Date(),
        })
        .where(eq(schema.comboSlots.id, params.slotId))
        .returning();
      const slot = rows[0];
      if (!slot) throw new NotFoundException(SLOT_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "combo_slot.updated", targetType: "combo_slot", targetId: slot.id, metadata: { name: params.name } },
        tx,
      );
      return slot;
    });
  }
}

function assertValidRange(minSelections: number, maxSelections: number | undefined): void {
  if (maxSelections !== undefined && maxSelections < minSelections) {
    throw new BadRequestException(INVALID_SELECTION_RANGE);
  }
}
