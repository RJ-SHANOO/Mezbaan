import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ModifierGroupRecord {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number | null;
  sortOrder: number;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateModifierGroupParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  minSelections?: number;
  maxSelections?: number;
  sortOrder?: number;
}

export interface UpdateModifierGroupParams {
  restaurantId: string;
  modifierGroupId: string;
  actorUserId: string;
  name?: string;
  minSelections?: number;
  maxSelections?: number | null;
  sortOrder?: number;
  status?: "active" | "inactive";
}

const GROUP_NOT_FOUND = "Modifier group not found";
const INVALID_SELECTION_RANGE = "maxSelections must be greater than or equal to minSelections";

/** Same CRUD reference pattern as CategoriesService (P1-17/P2-01). The
 * min/max invariant is checked here too, not just at the Zod boundary — this
 * service is called directly in tests (and could be called directly by any
 * other future caller) without going through the controller's parsing. */
@Injectable()
export class ModifierGroupsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<ModifierGroupRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx.select().from(schema.modifierGroups).orderBy(asc(schema.modifierGroups.sortOrder)),
    );
  }

  async create(params: CreateModifierGroupParams): Promise<ModifierGroupRecord> {
    const minSelections = params.minSelections ?? 0;
    assertValidRange(minSelections, params.maxSelections);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.modifierGroups)
        .values({
          restaurantId: params.restaurantId,
          name: params.name,
          minSelections,
          maxSelections: params.maxSelections ?? null,
          sortOrder: params.sortOrder ?? 0,
        })
        .returning();
      const group = rows[0];
      if (!group) throw new Error("create: modifier group insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "modifier_group.created",
          targetType: "modifier_group",
          targetId: group.id,
        },
        tx,
      );
      return group;
    });
  }

  async update(params: UpdateModifierGroupParams): Promise<ModifierGroupRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.modifierGroups).where(eq(schema.modifierGroups.id, params.modifierGroupId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(GROUP_NOT_FOUND);

      const nextMin = params.minSelections ?? existing.minSelections;
      const nextMax = params.maxSelections !== undefined ? params.maxSelections : existing.maxSelections;
      assertValidRange(nextMin, nextMax ?? undefined);

      const rows = await tx
        .update(schema.modifierGroups)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.minSelections !== undefined && { minSelections: params.minSelections }),
          ...(params.maxSelections !== undefined && { maxSelections: params.maxSelections }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          ...(params.status !== undefined && { status: params.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.modifierGroups.id, params.modifierGroupId))
        .returning();
      const group = rows[0];
      if (!group) throw new NotFoundException(GROUP_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "modifier_group.updated",
          targetType: "modifier_group",
          targetId: group.id,
          metadata: { name: params.name, status: params.status },
        },
        tx,
      );
      return group;
    });
  }
}

function assertValidRange(minSelections: number, maxSelections: number | undefined): void {
  if (maxSelections !== undefined && maxSelections < minSelections) {
    throw new BadRequestException(INVALID_SELECTION_RANGE);
  }
}
