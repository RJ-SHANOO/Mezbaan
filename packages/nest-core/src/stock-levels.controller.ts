import { Body, Controller, Get, Post, Query, UnauthorizedException } from "@nestjs/common";
import {
  ListStockLevelsQuerySchema,
  RebuildStockLevelsSchema,
  type RebuildStockLevelsResult,
  type StockLevel,
  type StockLevelDiscrepancy as StockLevelDiscrepancyResponse,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { StockLevelsService, type StockLevelDiscrepancy, type StockLevelRecord } from "./stock-levels.service.js";
import { parseOrBadRequest } from "./validation.js";

function toLevelResponse(level: StockLevelRecord): StockLevel {
  return {
    id: level.id,
    branchId: level.branchId,
    storageLocationId: level.storageLocationId,
    itemId: level.itemId,
    quantity: level.quantity,
    averageCostMinor: level.averageCostMinor?.toString() ?? null,
    currency: level.currency,
    updatedAt: level.updatedAt.toISOString(),
  };
}

function toDiscrepancyResponse(discrepancy: StockLevelDiscrepancy): StockLevelDiscrepancyResponse {
  return {
    branchId: discrepancy.branchId,
    storageLocationId: discrepancy.storageLocationId,
    itemId: discrepancy.itemId,
    storedQuantity: discrepancy.storedQuantity,
    actualQuantity: discrepancy.actualQuantity,
    storedCostMinor: discrepancy.storedCostMinor?.toString() ?? null,
    actualCostMinor: discrepancy.actualCostMinor?.toString() ?? null,
    currency: discrepancy.currency,
  };
}

@Controller("stock-levels")
export class StockLevelsController {
  constructor(private readonly stockLevelsService: StockLevelsService) {}

  @Get()
  @RequirePermission("inventory.adjust")
  async list(@Query() query: unknown): Promise<StockLevel[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListStockLevelsQuerySchema, query);
    const levels = await this.stockLevelsService.list({ restaurantId: tenant.restaurantId, ...request });
    return levels.map(toLevelResponse);
  }

  /** The "rebuild tool" this task is named for: recomputes every level
   * fresh from stock_ledger and reports any drift. apply: false (the
   * default) is a dry-run verify; apply: true also corrects the cache. */
  @Post("rebuild")
  @RequirePermission("inventory.adjust")
  async rebuild(@Body() body: unknown): Promise<RebuildStockLevelsResult> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RebuildStockLevelsSchema, body);
    const result = await this.stockLevelsService.rebuild({ restaurantId: tenant.restaurantId, ...request });
    return { checked: result.checked, discrepancies: result.discrepancies.map(toDiscrepancyResponse), applied: result.applied };
  }
}

function requireTenant(): { restaurantId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId };
}
