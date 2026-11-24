import { Body, Controller, Get, Post, Query, UnauthorizedException } from "@nestjs/common";
import { ListStockMovementsQuerySchema, RecordStockMovementSchema, RecordTransferSchema, type StockMovement, type StockMovementPage } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { StockLedgerService, type StockMovementRecord } from "./stock-ledger.service.js";
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

@Controller("stock-ledger")
export class StockLedgerController {
  constructor(private readonly stockLedgerService: StockLedgerService) {}

  @Get()
  @RequirePermission("inventory.adjust")
  async list(@Query() query: unknown): Promise<StockMovementPage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListStockMovementsQuerySchema, query);
    const page = await this.stockLedgerService.list({ restaurantId: tenant.restaurantId, ...request });
    return { items: page.items.map(toMovementResponse), nextCursor: page.nextCursor };
  }

  @Post()
  @RequirePermission("inventory.adjust")
  async record(@Body() body: unknown): Promise<StockMovement> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RecordStockMovementSchema, body);
    const movement = await this.stockLedgerService.recordMovement({
      ...request,
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      unitCostMinor: request.unitCostMinor !== undefined ? BigInt(request.unitCostMinor) : undefined,
    });
    return toMovementResponse(movement);
  }

  @Post("transfer")
  @RequirePermission("inventory.adjust")
  async transfer(@Body() body: unknown): Promise<{ outbound: StockMovement; inbound: StockMovement }> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RecordTransferSchema, body);
    const { outbound, inbound } = await this.stockLedgerService.recordTransfer({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return { outbound: toMovementResponse(outbound), inbound: toMovementResponse(inbound) };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
