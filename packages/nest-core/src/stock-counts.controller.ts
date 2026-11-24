import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  ApproveStockCountSchema,
  ListStockCountsQuerySchema,
  StartStockCountSchema,
  SubmitStockCountLineSchema,
  type ApproveStockCountResult,
  type StockCount,
  type StockCountSummaryPage,
  type StockMovement,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { StockCountsService, type StockCountItemRecord, type StockCountRecord } from "./stock-counts.service.js";
import type { StockMovementRecord } from "./stock-ledger.service.js";
import { parseOrBadRequest } from "./validation.js";

const StockCountIdParamSchema = z.object({ id: z.string().uuid() });
const StockCountItemParamSchema = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });

function toRecordResponse(count: StockCountRecord): StockCount {
  return {
    id: count.id,
    branchId: count.branchId,
    storageLocationId: count.storageLocationId,
    countType: count.countType,
    status: count.status,
    startedByUserId: count.startedByUserId,
    submittedAt: count.submittedAt?.toISOString() ?? null,
    approvedByUserId: count.approvedByUserId,
    approvedAt: count.approvedAt?.toISOString() ?? null,
    note: count.note,
    items: count.items.map(toItemResponse),
    createdAt: count.createdAt.toISOString(),
    updatedAt: count.updatedAt.toISOString(),
  };
}

function toMovementResponse(movement: StockMovementRecord): StockMovement {
  return {
    id: movement.id,
    branchId: movement.branchId,
    storageLocationId: movement.storageLocationId,
    itemId: movement.itemId,
    movementType: movement.movementType,
    quantityDelta: movement.quantityDelta,
    transferGroupId: movement.transferGroupId,
    productionBatchId: movement.productionBatchId,
    invoiceId: movement.invoiceId,
    unitCostMinor: movement.unitCostMinor?.toString() ?? null,
    currency: movement.currency,
    note: movement.note,
    actorUserId: movement.actorUserId,
    createdAt: movement.createdAt.toISOString(),
  };
}

function toItemResponse(item: StockCountItemRecord) {
  return {
    id: item.id,
    itemId: item.itemId,
    expectedQuantity: item.expectedQuantity,
    countedQuantity: item.countedQuantity,
    countedAt: item.countedAt?.toISOString() ?? null,
    countedByUserId: item.countedByUserId,
  };
}

@Controller("stock-counts")
export class StockCountsController {
  constructor(private readonly stockCountsService: StockCountsService) {}

  @Get()
  @RequirePermission("inventory.adjust")
  async list(@Query() query: unknown): Promise<StockCountSummaryPage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListStockCountsQuerySchema, query);
    const page = await this.stockCountsService.list({ restaurantId: tenant.restaurantId, ...request });
    return { items: page.items.map((count) => toRecordResponse({ ...count, items: [] })), nextCursor: page.nextCursor };
  }

  @Get(":id")
  @RequirePermission("inventory.adjust")
  async get(@Param() params: unknown): Promise<StockCount> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(StockCountIdParamSchema, params);
    const count = await this.stockCountsService.get({ restaurantId: tenant.restaurantId, stockCountId: id });
    return toRecordResponse(count);
  }

  @Post()
  @RequirePermission("inventory.adjust")
  async start(@Body() body: unknown): Promise<StockCount> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(StartStockCountSchema, body);
    const count = await this.stockCountsService.start({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toRecordResponse(count);
  }

  @Post(":id/items/:itemId")
  @RequirePermission("inventory.adjust")
  async submitLineCount(@Param() params: unknown, @Body() body: unknown) {
    const tenant = requireTenant();
    const { id, itemId } = parseOrBadRequest(StockCountItemParamSchema, params);
    const request = parseOrBadRequest(SubmitStockCountLineSchema, body);
    const line = await this.stockCountsService.submitLineCount({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, stockCountId: id, itemId, countedQuantity: request.countedQuantity });
    return toItemResponse(line);
  }

  @Post(":id/submit")
  @RequirePermission("inventory.adjust")
  async finalize(@Param() params: unknown): Promise<StockCount> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(StockCountIdParamSchema, params);
    const count = await this.stockCountsService.finalize({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, stockCountId: id });
    return toRecordResponse(count);
  }

  @Post(":id/approve")
  @RequirePermission("inventory.adjust")
  async approve(@Param() params: unknown, @Body() body: unknown): Promise<ApproveStockCountResult> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(StockCountIdParamSchema, params);
    const request = parseOrBadRequest(ApproveStockCountSchema, body);
    const result = await this.stockCountsService.approve({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, stockCountId: id, ...request });
    return { stockCount: toRecordResponse(result.stockCount), adjustments: result.adjustments.map(toMovementResponse) };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
