import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { BillingPlanService, DEFAULT_BILLING_PLAN, type BillingPlanRecord } from "./billing-plan.service.js";
import { DATABASE } from "./db.module.js";
import { DeviceService, type DeviceRecord } from "./device.service.js";
import { SettlementStatementsService } from "./settlement-statements.service.js";

export type RestaurantStatus = "active" | "suspended";

export interface RestaurantSummaryRecord {
  id: string;
  name: string;
  slug: string;
  status: RestaurantStatus;
  branchCount: number;
  deviceCount: number;
  billingPlan: BillingPlanRecord;
  createdAt: Date;
}

export interface RestaurantBranchSummaryRecord {
  id: string;
  name: string;
  status: "active" | "inactive";
}

export interface OutstandingSettlementRecord {
  currency: string;
  remainingAmountMinor: bigint;
}

export interface RestaurantDetailRecord extends RestaurantSummaryRecord {
  branches: RestaurantBranchSummaryRecord[];
  devices: DeviceRecord[];
  outstandingSettlements: OutstandingSettlementRecord[];
}

export interface SetRestaurantStatusParams {
  restaurantId: string;
  actorUserId: string;
  status: RestaurantStatus;
}

const RESTAURANT_NOT_FOUND = "Restaurant not found";
const STATUS_UNCHANGED = "restaurant is already in this status";

/**
 * P3-39: Super Admin's restaurant list, detail ("support tool") lookup and
 * status control. Every read here is a Super Admin cross-tenant query
 * (`withTenant(db, { restaurantId: null, isSuperAdmin: true })`, the same
 * shape OnboardingService/OutboxWorkerService already use) — there is no
 * tenant-scoped equivalent of any of these, unlike BillingPlanService or
 * FeatureFlagsService, which also expose a restaurant's own read of itself.
 */
@Injectable()
export class RestaurantsAdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly billingPlanService: BillingPlanService,
    private readonly deviceService: DeviceService,
    private readonly settlementStatementsService: SettlementStatementsService,
  ) {}

  /** One query per table, joined in memory by restaurantId — avoids an
   * N+1 per-restaurant round trip (rule from P1-33/P2-41) at a list this
   * codebase expects to stay in the low thousands of rows (section 6:
   * "100-1,000 restaurants"), never per-sale volume. */
  async list(): Promise<RestaurantSummaryRecord[]> {
    return withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const restaurantRows = await tx.select().from(schema.restaurants);
      const branchCountRows = await tx
        .select({ restaurantId: schema.branches.restaurantId, count: sql<string>`count(*)` })
        .from(schema.branches)
        .groupBy(schema.branches.restaurantId);
      const deviceCountRows = await tx
        .select({ restaurantId: schema.devices.restaurantId, count: sql<string>`count(*)` })
        .from(schema.devices)
        .groupBy(schema.devices.restaurantId);
      const planRows = await tx.select().from(schema.billingPlanSettings);

      const branchCounts = new Map(branchCountRows.map((row) => [row.restaurantId, Number(row.count)]));
      const deviceCounts = new Map(deviceCountRows.map((row) => [row.restaurantId, Number(row.count)]));
      const plans = new Map(planRows.map((row) => [row.restaurantId, row]));

      return restaurantRows.map((restaurant) => ({
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        status: restaurant.status,
        branchCount: branchCounts.get(restaurant.id) ?? 0,
        deviceCount: deviceCounts.get(restaurant.id) ?? 0,
        billingPlan: plans.get(restaurant.id) ?? DEFAULT_BILLING_PLAN,
        createdAt: restaurant.createdAt,
      }));
    });
  }

  /** The full "what's going on with this restaurant" lookup. Each piece is
   * its own top-level call rather than nested inside one shared
   * transaction — BillingPlanService/DeviceService/SettlementStatementsService
   * each open and manage their own `withTenant` transaction internally, and
   * nesting a second transaction inside an already-open one would open a
   * separate pooled connection rather than reuse it (the exact bug class
   * P3-22 self-caught). This is a read-only support view with no money
   * being written, so a few independent, eventually-consistent reads are
   * the right tradeoff, not a single atomic snapshot. */
  async getDetail(restaurantId: string): Promise<RestaurantDetailRecord> {
    const { restaurant, branchRows } = await withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const restaurantRows = await tx.select().from(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
      const found = restaurantRows[0];
      if (!found) throw new NotFoundException(RESTAURANT_NOT_FOUND);

      const branches = await tx
        .select({ id: schema.branches.id, name: schema.branches.name, status: schema.branches.status })
        .from(schema.branches)
        .where(eq(schema.branches.restaurantId, restaurantId));

      return { restaurant: found, branchRows: branches };
    });

    const [billingPlan, devices, statements] = await Promise.all([
      this.billingPlanService.getForRestaurantAsSuperAdmin(restaurantId),
      this.deviceService.listAsSuperAdmin(restaurantId),
      this.settlementStatementsService.listForRestaurantAsSuperAdmin(restaurantId),
    ]);

    const outstandingByCurrency = new Map<string, bigint>();
    for (const statement of statements) {
      const balance = await this.settlementStatementsService.getBalance({ restaurantId, statementId: statement.id, asSuperAdmin: true });
      if (balance.remainingAmountMinor <= 0n) continue;
      outstandingByCurrency.set(balance.currency, (outstandingByCurrency.get(balance.currency) ?? 0n) + balance.remainingAmountMinor);
    }

    return {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      status: restaurant.status,
      branchCount: branchRows.length,
      deviceCount: devices.length,
      billingPlan,
      createdAt: restaurant.createdAt,
      branches: branchRows,
      devices,
      outstandingSettlements: Array.from(outstandingByCurrency, ([currency, remainingAmountMinor]) => ({ currency, remainingAmountMinor })),
    };
  }

  /** A single restaurant's summary row — used after setStatus to return
   * the fresh value without re-querying every restaurant via list(). */
  async getSummary(restaurantId: string): Promise<RestaurantSummaryRecord> {
    return withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const restaurantRows = await tx.select().from(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
      const restaurant = restaurantRows[0];
      if (!restaurant) throw new NotFoundException(RESTAURANT_NOT_FOUND);

      const branchCountRows = await tx.select({ count: sql<string>`count(*)` }).from(schema.branches).where(eq(schema.branches.restaurantId, restaurantId));
      const deviceCountRows = await tx.select({ count: sql<string>`count(*)` }).from(schema.devices).where(eq(schema.devices.restaurantId, restaurantId));
      const planRows = await tx.select().from(schema.billingPlanSettings).where(eq(schema.billingPlanSettings.restaurantId, restaurantId));

      return {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        status: restaurant.status,
        branchCount: Number(branchCountRows[0]?.count ?? 0),
        deviceCount: Number(deviceCountRows[0]?.count ?? 0),
        billingPlan: planRows[0] ?? DEFAULT_BILLING_PLAN,
        createdAt: restaurant.createdAt,
      };
    });
  }

  async setStatus(params: SetRestaurantStatusParams): Promise<void> {
    await withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const restaurantRows = await tx.select({ status: schema.restaurants.status }).from(schema.restaurants).where(eq(schema.restaurants.id, params.restaurantId));
      const restaurant = restaurantRows[0];
      if (!restaurant) throw new NotFoundException(RESTAURANT_NOT_FOUND);
      if (restaurant.status === params.status) throw new BadRequestException(STATUS_UNCHANGED);

      await tx.update(schema.restaurants).set({ status: params.status, updatedAt: new Date() }).where(eq(schema.restaurants.id, params.restaurantId));

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: params.status === "suspended" ? "restaurant.suspended" : "restaurant.reactivated",
          targetType: "restaurant",
          targetId: params.restaurantId,
          metadata: { previousStatus: restaurant.status, newStatus: params.status },
        },
        tx,
      );
    });
  }
}
