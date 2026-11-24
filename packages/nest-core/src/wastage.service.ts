import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";
import { ManagerPinService } from "./manager-pin.service.js";
import { StockLedgerService, type StockMovementRecord } from "./stock-ledger.service.js";
import { computeLineCost } from "./stock-deduction-shared.js";
import { StockLevelsService } from "./stock-levels.service.js";

export interface WastageReasonCodeRecord {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetWastageReasonCodeParams {
  restaurantId: string;
  actorUserId: string;
  code: string;
  label: string;
  isActive?: boolean;
}

export interface WastageLimitSettingsRecord {
  maxUnapprovedCostMinor: bigint | null;
  updatedByUserId: string;
  updatedAt: Date;
}

export interface UpdateWastageLimitSettingsParams {
  restaurantId: string;
  actorUserId: string;
  maxUnapprovedCostMinor: bigint | null;
}

export interface RecordWastageParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  storageLocationId: string;
  itemId: string;
  quantity: number;
  reasonCode: string;
  note?: string;
  managerUserId?: string;
  managerPin?: string;
}

export interface WastageEntryRecord {
  id: string;
  branchId: string;
  storageLocationId: string;
  itemId: string;
  quantity: number;
  reasonCode: string;
  costMinor: bigint | null;
  currency: string | null;
  requiredApproval: boolean;
  approvedByUserId: string | null;
  actorUserId: string;
  note: string | null;
  createdAt: Date;
}

export interface RecordWastageResult {
  entry: WastageEntryRecord;
  movement: StockMovementRecord;
}

export interface ListWastageEntriesParams {
  restaurantId: string;
  branchId?: string;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 20;
const QUANTITY_MUST_BE_POSITIVE = "quantity must be positive";
const LOCATION_NOT_FOUND = "Storage location not found";
const LOCATION_WRONG_BRANCH = "this storage location doesn't belong to the given branch";
const REASON_CODE_NOT_FOUND = "this wastage reason code doesn't exist or is no longer active";
const APPROVAL_REQUIRED = "this wastage entry's cost exceeds the restaurant's own-authority limit and needs a manager's approval (managerUserId and managerPin)";

/**
 * P3-28: an ad-hoc wastage entry — a standalone stock loss with no sale,
 * void, or purchase behind it. `recordWastage` costs the entry at the
 * item's current weighted-average cost (computeLineCost, same primitive
 * SalesStockDeductionService/VoidsService already use) and compares that
 * against wastage_limit_settings' own-authority limit, same two-tier
 * pattern as DiscountsService (P2-22) — a restaurant with no limit
 * configured requires approval for every entry, the safer default.
 * Append-only (rule 4, UPDATE/DELETE revoked in app-role.ts) — a real
 * event, same as goods-received-notes.ts/purchase-returns.ts.
 */
@Injectable()
export class WastageService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly managerPinService: ManagerPinService,
    private readonly stockLedgerService: StockLedgerService,
    private readonly stockLevelsService: StockLevelsService,
  ) {}

  async listReasonCodes(restaurantId: string): Promise<WastageReasonCodeRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.wastageReasonCodes));
  }

  async setReasonCode(params: SetWastageReasonCodeParams): Promise<WastageReasonCodeRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.wastageReasonCodes)
        .values({ restaurantId: params.restaurantId, code: params.code, label: params.label, isActive: params.isActive ?? true })
        .onConflictDoUpdate({
          target: [schema.wastageReasonCodes.restaurantId, schema.wastageReasonCodes.code],
          set: { label: params.label, isActive: params.isActive ?? true, updatedAt: new Date() },
        })
        .returning();
      const reasonCode = rows[0];
      if (!reasonCode) throw new Error("setReasonCode: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "wastage_reason_code.set", targetType: "wastage_reason_code", targetId: reasonCode.id, metadata: { code: params.code } },
        tx,
      );
      return reasonCode;
    });
  }

  async getLimitSettings(restaurantId: string): Promise<WastageLimitSettingsRecord | null> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.wastageLimitSettings).where(eq(schema.wastageLimitSettings.restaurantId, restaurantId));
      return rows[0] ?? null;
    });
  }

  async updateLimitSettings(params: UpdateWastageLimitSettingsParams): Promise<WastageLimitSettingsRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.wastageLimitSettings)
        .values({ restaurantId: params.restaurantId, maxUnapprovedCostMinor: params.maxUnapprovedCostMinor, updatedByUserId: params.actorUserId })
        .onConflictDoUpdate({
          target: schema.wastageLimitSettings.restaurantId,
          set: { maxUnapprovedCostMinor: params.maxUnapprovedCostMinor, updatedByUserId: params.actorUserId, updatedAt: new Date() },
        })
        .returning();
      const settings = rows[0];
      if (!settings) throw new Error("updateLimitSettings: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "wastage_limit_settings.updated", targetType: "wastage_limit_settings", targetId: settings.id, metadata: { maxUnapprovedCostMinor: params.maxUnapprovedCostMinor?.toString() ?? null } },
        tx,
      );
      return settings;
    });
  }

  async recordWastage(params: RecordWastageParams): Promise<RecordWastageResult> {
    if (params.quantity <= 0) throw new BadRequestException(QUANTITY_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const locationRows = await tx.select({ branchId: schema.storageLocations.branchId }).from(schema.storageLocations).where(eq(schema.storageLocations.id, params.storageLocationId));
      const location = locationRows[0];
      if (!location) throw new NotFoundException(LOCATION_NOT_FOUND);
      if (location.branchId !== params.branchId) throw new BadRequestException(LOCATION_WRONG_BRANCH);

      const reasonRows = await tx.select({ isActive: schema.wastageReasonCodes.isActive }).from(schema.wastageReasonCodes).where(eq(schema.wastageReasonCodes.code, params.reasonCode));
      if (!reasonRows[0] || !reasonRows[0].isActive) throw new BadRequestException(REASON_CODE_NOT_FOUND);

      const cost = await computeLineCost(tx, this.stockLevelsService, params.restaurantId, params.storageLocationId, new Map([[params.itemId, params.quantity]]));

      const limitRows = await tx.select().from(schema.wastageLimitSettings).where(eq(schema.wastageLimitSettings.restaurantId, params.restaurantId));
      const maxUnapprovedCostMinor = limitRows[0]?.maxUnapprovedCostMinor ?? null;
      // No limit configured at all, or no established cost to compare — both
      // mean "can't confirm this is within any own-authority limit," so both
      // require approval, same conservative default as discount_limit_settings.
      const requiredApproval = maxUnapprovedCostMinor === null || cost === null || cost.amountMinor > maxUnapprovedCostMinor;

      let approvedByUserId: string | null = null;
      if (requiredApproval) {
        if (!params.managerUserId || !params.managerPin) throw new BadRequestException(APPROVAL_REQUIRED);
        await this.managerPinService.approve({
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          managerUserId: params.managerUserId,
          pin: params.managerPin,
          requiredPermission: "inventory.wastage.approve",
          action: "wastage_entry.record",
        });
        approvedByUserId = params.managerUserId;
      }

      const movement = await this.stockLedgerService.recordMovementInTx(tx, {
        restaurantId: params.restaurantId,
        actorUserId: params.actorUserId,
        storageLocationId: params.storageLocationId,
        itemId: params.itemId,
        movementType: "wastage",
        quantityDelta: -params.quantity,
        note: `wastage: ${params.reasonCode}`,
      });

      const entryRows = await tx
        .insert(schema.wastageEntries)
        .values({
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          storageLocationId: params.storageLocationId,
          itemId: params.itemId,
          quantity: params.quantity,
          reasonCode: params.reasonCode,
          costMinor: cost?.amountMinor ?? null,
          currency: cost?.currency ?? null,
          requiredApproval,
          approvedByUserId,
          actorUserId: params.actorUserId,
          note: params.note ?? null,
        })
        .returning();
      const entry = entryRows[0];
      if (!entry) throw new Error("recordWastage: wastage entry insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          actorUserId: params.actorUserId,
          action: "wastage_entry.recorded",
          targetType: "wastage_entry",
          targetId: entry.id,
          metadata: { itemId: params.itemId, quantity: params.quantity, reasonCode: params.reasonCode, requiredApproval, approvedByUserId },
        },
        tx,
      );

      return { entry, movement };
    });
  }

  async list(params: ListWastageEntriesParams): Promise<Page<WastageEntryRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.wastageEntries)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.wastageEntries.branchId, params.branchId) : undefined,
            seekCondition(schema.wastageEntries.createdAt, schema.wastageEntries.id, after),
          ),
        )
        .orderBy(desc(schema.wastageEntries.createdAt), desc(schema.wastageEntries.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }
}
