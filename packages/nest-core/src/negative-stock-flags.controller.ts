import { Controller, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { ListNegativeStockFlagsQuerySchema, type NegativeStockFlag, type NegativeStockFlagPage } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { NegativeStockFlagsService, type NegativeStockFlagRecord } from "./negative-stock-flags.service.js";
import { parseOrBadRequest } from "./validation.js";

const FlagIdParamSchema = z.object({ id: z.string().uuid() });

function toFlagResponse(flag: NegativeStockFlagRecord): NegativeStockFlag {
  return {
    id: flag.id,
    branchId: flag.branchId,
    storageLocationId: flag.storageLocationId,
    itemId: flag.itemId,
    stockLedgerId: flag.stockLedgerId,
    quantityAfter: flag.quantityAfter,
    reviewedAt: flag.reviewedAt?.toISOString() ?? null,
    reviewedByUserId: flag.reviewedByUserId,
    createdAt: flag.createdAt.toISOString(),
  };
}

/** P3-12: the review screen's API — list flags (defaulting a working view
 * to open ones via `reviewed=false`) and mark one reviewed. */
@Controller("negative-stock-flags")
export class NegativeStockFlagsController {
  constructor(private readonly negativeStockFlagsService: NegativeStockFlagsService) {}

  @Get()
  @RequirePermission("inventory.adjust")
  async list(@Query() query: unknown): Promise<NegativeStockFlagPage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListNegativeStockFlagsQuerySchema, query);
    const page = await this.negativeStockFlagsService.list({ restaurantId: tenant.restaurantId, ...request });
    return { items: page.items.map(toFlagResponse), nextCursor: page.nextCursor };
  }

  @Post(":id/review")
  @RequirePermission("inventory.adjust")
  async review(@Param() params: unknown): Promise<NegativeStockFlag> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(FlagIdParamSchema, params);
    const flag = await this.negativeStockFlagsService.review({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, flagId: id });
    return toFlagResponse(flag);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
