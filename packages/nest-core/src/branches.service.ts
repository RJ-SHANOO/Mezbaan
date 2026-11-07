import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface BranchRecord {
  id: string;
  name: string;
  timezone: string;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBranchParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  timezone: string;
}

export interface UpdateBranchParams {
  restaurantId: string;
  branchId: string;
  actorUserId: string;
  name?: string;
  timezone?: string;
  status?: "active" | "inactive";
}

const BRANCH_NOT_FOUND = "Branch not found";

/**
 * The reference pattern for CRUD modules (P1-17): every read/write goes through
 * withTenant, every mutation is audited, and "not found" is only ever "not found in
 * this tenant" — RLS (the second barrier) makes a cross-tenant id simply invisible
 * rather than a distinguishable error, so the 404 here covers both cases uniformly.
 */
@Injectable()
export class BranchesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<BranchRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.branches));
  }

  async create(params: CreateBranchParams): Promise<BranchRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.branches)
        .values({ restaurantId: params.restaurantId, name: params.name, timezone: params.timezone })
        .returning();
      const branch = rows[0];
      if (!branch) throw new Error("create: branch insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: branch.id,
          actorUserId: params.actorUserId,
          action: "branch.created",
          targetType: "branch",
          targetId: branch.id,
        },
        tx,
      );
      return branch;
    });
  }

  async update(params: UpdateBranchParams): Promise<BranchRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.branches)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.timezone !== undefined && { timezone: params.timezone }),
          ...(params.status !== undefined && { status: params.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.branches.id, params.branchId))
        .returning();
      const branch = rows[0];
      if (!branch) throw new NotFoundException(BRANCH_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: branch.id,
          actorUserId: params.actorUserId,
          action: "branch.updated",
          targetType: "branch",
          targetId: branch.id,
          metadata: { name: params.name, timezone: params.timezone, status: params.status },
        },
        tx,
      );
      return branch;
    });
  }
}
