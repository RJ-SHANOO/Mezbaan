import { Body, Controller, Post, UnauthorizedException } from "@nestjs/common";
import { RecordProductionBatchSchema, type ProductionBatchResult, type StockMovement } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ProductionService } from "./production.service.js";
import type { StockMovementRecord } from "./stock-ledger.service.js";
import { parseOrBadRequest } from "./validation.js";

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

@Controller("production-batches")
export class ProductionController {
  constructor(private readonly productionService: ProductionService) {}

  @Post()
  @RequirePermission("inventory.adjust")
  async recordBatch(@Body() body: unknown): Promise<ProductionBatchResult> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RecordProductionBatchSchema, body);
    const result = await this.productionService.recordBatch({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return {
      productionBatchId: result.productionBatchId,
      consumed: result.consumed.map(toMovementResponse),
      produced: toMovementResponse(result.produced),
    };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
