import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ModifierOptionRecord {
  id: string;
  modifierGroupId: string;
  name: string;
  sortOrder: number;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateModifierOptionParams {
  restaurantId: string;
  actorUserId: string;
  modifierGroupId: string;
  name: string;
  sortOrder?: number;
}

export interface UpdateModifierOptionParams {
  restaurantId: string;
  optionId: string;
  actorUserId: string;
  name?: string;
  sortOrder?: number;
  status?: "active" | "inactive";
}

const OPTION_NOT_FOUND = "Modifier option not found";
const GROUP_NOT_FOUND = "Modifier group not found";

/** Same CRUD reference pattern as ProductVariantsService — modifierGroupId's
 * existence is checked explicitly under this tenant's own RLS context before
 * insert, for the same FK-bypasses-RLS reason documented on ProductsService. */
@Injectable()
export class ModifierOptionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, modifierGroupId: string): Promise<ModifierOptionRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.modifierOptions)
        .where(eq(schema.modifierOptions.modifierGroupId, modifierGroupId))
        .orderBy(asc(schema.modifierOptions.sortOrder)),
    );
  }

  async create(params: CreateModifierOptionParams): Promise<ModifierOptionRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const groupRows = await tx
        .select({ id: schema.modifierGroups.id })
        .from(schema.modifierGroups)
        .where(eq(schema.modifierGroups.id, params.modifierGroupId));
      if (groupRows.length === 0) throw new NotFoundException(GROUP_NOT_FOUND);

      const rows = await tx
        .insert(schema.modifierOptions)
        .values({
          restaurantId: params.restaurantId,
          modifierGroupId: params.modifierGroupId,
          name: params.name,
          sortOrder: params.sortOrder ?? 0,
        })
        .returning();
      const option = rows[0];
      if (!option) throw new Error("create: modifier option insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "modifier_option.created",
          targetType: "modifier_option",
          targetId: option.id,
        },
        tx,
      );
      return option;
    });
  }

  async update(params: UpdateModifierOptionParams): Promise<ModifierOptionRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.modifierOptions)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sortOrder !== undefined && { sortOrder: params.sortOrder }),
          ...(params.status !== undefined && { status: params.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.modifierOptions.id, params.optionId))
        .returning();
      const option = rows[0];
      if (!option) throw new NotFoundException(OPTION_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "modifier_option.updated",
          targetType: "modifier_option",
          targetId: option.id,
          metadata: { name: params.name, status: params.status },
        },
        tx,
      );
      return option;
    });
  }
}
