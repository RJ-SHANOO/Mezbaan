import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";

export type MovementType = "purchase" | "sale" | "return" | "wastage" | "adjustment" | "count" | "production" | "transfer";

export interface StockMovementRecord {
  id: string;
  branchId: string;
  storageLocationId: string;
  itemId: string;
  movementType: MovementType;
  quantityDelta: number;
  transferGroupId: string | null;
  note: string | null;
  actorUserId: string;
  createdAt: Date;
}

export interface RecordMovementParams {
  restaurantId: string;
  actorUserId: string;
  storageLocationId: string;
  itemId: string;
  movementType: Exclude<MovementType, "transfer">;
  quantityDelta: number;
  note?: string;
}

export interface RecordTransferParams {
  restaurantId: string;
  actorUserId: string;
  itemId: string;
  fromStorageLocationId: string;
  toStorageLocationId: string;
  quantity: number;
  note?: string;
}

export interface ListMovementsParams {
  restaurantId: string;
  branchId?: string;
  storageLocationId?: string;
  itemId?: string;
  movementType?: MovementType;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 20;
const ITEM_NOT_FOUND = "Inventory item not found";
const LOCATION_NOT_FOUND = "Storage location not found";
const QUANTITY_ZERO = "quantityDelta must not be zero";
const SAME_LOCATION_TRANSFER = "fromStorageLocationId and toStorageLocationId must be different";
const CROSS_BRANCH_TRANSFER = "a transfer between different branches isn't supported yet — that's a planned, separate branch-transfer workflow (request/dispatch/receive), not a same-branch location move";

/**
 * P3-09: the append-only stock ledger (rule 4 — UPDATE/DELETE revoked at
 * the DB level in app-role.ts, same enforcement as invoices/payments/
 * refunds/credit_ledger_entries). This is the *only* source of truth for
 * stock — branch/location stock levels are always derived by summing it
 * (P3-10's job), never stored separately. A wrong entry is corrected with
 * a new, opposite-signed row, never an edit.
 *
 * `quantityDelta` must already be in the item's own base unit
 * (inventory_items.baseUnitId) — a caller working in a different unit
 * (e.g. receiving a purchase in cartons) converts first via
 * InventoryItemUnitConversionsService/packages/domain's convertQuantity,
 * same "this table never converts on its own" reasoning as the schema's
 * own docs.
 *
 * A "transfer" is the one movement type that always produces two rows —
 * see recordTransfer — restricted to two locations in the *same* branch
 * for now; a cross-branch transfer is P4-12's own, more elaborate
 * request/dispatch/receive workflow, not this primitive.
 */
@Injectable()
export class StockLedgerService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async recordMovement(params: RecordMovementParams): Promise<StockMovementRecord> {
    if (params.quantityDelta === 0) throw new BadRequestException(QUANTITY_ZERO);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireItem(tx, params.itemId);
      const location = await this.requireLocation(tx, params.storageLocationId);

      const rows = await tx
        .insert(schema.stockLedger)
        .values({
          restaurantId: params.restaurantId,
          branchId: location.branchId,
          storageLocationId: params.storageLocationId,
          itemId: params.itemId,
          movementType: params.movementType,
          quantityDelta: params.quantityDelta,
          note: params.note ?? null,
          actorUserId: params.actorUserId,
        })
        .returning();
      const movement = rows[0];
      if (!movement) throw new Error("recordMovement: insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: movement.branchId,
          actorUserId: params.actorUserId,
          action: "stock_ledger.movement_recorded",
          targetType: "stock_ledger",
          targetId: movement.id,
          metadata: { itemId: movement.itemId, movementType: movement.movementType, quantityDelta: movement.quantityDelta, storageLocationId: movement.storageLocationId },
        },
        tx,
      );
      return movement;
    });
  }

  /** Always two rows, sharing a new transferGroupId: a negative entry at
   * `fromStorageLocationId`, a positive one at `toStorageLocationId`. */
  async recordTransfer(params: RecordTransferParams): Promise<{ outbound: StockMovementRecord; inbound: StockMovementRecord }> {
    if (params.fromStorageLocationId === params.toStorageLocationId) throw new BadRequestException(SAME_LOCATION_TRANSFER);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireItem(tx, params.itemId);
      const fromLocation = await this.requireLocation(tx, params.fromStorageLocationId);
      const toLocation = await this.requireLocation(tx, params.toStorageLocationId);
      if (fromLocation.branchId !== toLocation.branchId) throw new BadRequestException(CROSS_BRANCH_TRANSFER);

      const transferGroupId = randomUUID();
      const outboundRows = await tx
        .insert(schema.stockLedger)
        .values({
          restaurantId: params.restaurantId,
          branchId: fromLocation.branchId,
          storageLocationId: params.fromStorageLocationId,
          itemId: params.itemId,
          movementType: "transfer",
          quantityDelta: -params.quantity,
          transferGroupId,
          note: params.note ?? null,
          actorUserId: params.actorUserId,
        })
        .returning();
      const inboundRows = await tx
        .insert(schema.stockLedger)
        .values({
          restaurantId: params.restaurantId,
          branchId: toLocation.branchId,
          storageLocationId: params.toStorageLocationId,
          itemId: params.itemId,
          movementType: "transfer",
          quantityDelta: params.quantity,
          transferGroupId,
          note: params.note ?? null,
          actorUserId: params.actorUserId,
        })
        .returning();
      const outbound = outboundRows[0];
      const inbound = inboundRows[0];
      if (!outbound || !inbound) throw new Error("recordTransfer: insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "stock_ledger.transfer_recorded",
          targetType: "stock_ledger",
          targetId: transferGroupId,
          metadata: { itemId: params.itemId, fromStorageLocationId: params.fromStorageLocationId, toStorageLocationId: params.toStorageLocationId, quantity: params.quantity },
        },
        tx,
      );
      return { outbound, inbound };
    });
  }

  async list(params: ListMovementsParams): Promise<Page<StockMovementRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.stockLedger)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.stockLedger.branchId, params.branchId) : undefined,
            params.storageLocationId !== undefined ? eq(schema.stockLedger.storageLocationId, params.storageLocationId) : undefined,
            params.itemId !== undefined ? eq(schema.stockLedger.itemId, params.itemId) : undefined,
            params.movementType !== undefined ? eq(schema.stockLedger.movementType, params.movementType) : undefined,
            seekCondition(schema.stockLedger.createdAt, schema.stockLedger.id, after),
          ),
        )
        .orderBy(desc(schema.stockLedger.createdAt), desc(schema.stockLedger.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }

  private async requireItem(tx: Database, itemId: string): Promise<void> {
    const rows = await tx.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(eq(schema.inventoryItems.id, itemId));
    if (rows.length === 0) throw new NotFoundException(ITEM_NOT_FOUND);
  }

  private async requireLocation(tx: Database, locationId: string): Promise<{ branchId: string }> {
    const rows = await tx.select({ branchId: schema.storageLocations.branchId }).from(schema.storageLocations).where(eq(schema.storageLocations.id, locationId));
    const location = rows[0];
    if (!location) throw new NotFoundException(LOCATION_NOT_FOUND);
    return location;
  }
}
