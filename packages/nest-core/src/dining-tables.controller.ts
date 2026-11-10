import { Body, Controller, Get, Param, Patch, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateDiningTableSchema, ListDiningTablesQuerySchema, UpdateDiningTableSchema, type DiningTable } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { DiningTablesService, type DiningTableRecord } from "./dining-tables.service.js";
import { parseOrBadRequest } from "./validation.js";

const TableIdParamSchema = z.object({ id: z.string().uuid() });

function toTableResponse(table: DiningTableRecord): DiningTable {
  return {
    id: table.id,
    branchId: table.branchId,
    floorId: table.floorId,
    name: table.name,
    seatCount: table.seatCount,
    positionX: table.positionX,
    positionY: table.positionY,
    status: table.status,
    qrToken: table.qrToken,
    createdAt: table.createdAt.toISOString(),
    updatedAt: table.updatedAt.toISOString(),
  };
}

@Controller("tables")
export class DiningTablesController {
  constructor(private readonly diningTablesService: DiningTablesService) {}

  @Get()
  @RequirePermission("tables.manage")
  async list(@Query() query: unknown): Promise<DiningTable[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListDiningTablesQuerySchema, query);
    const tables = await this.diningTablesService.list(tenant.restaurantId, request.branchId);
    return tables.map(toTableResponse);
  }

  @Post()
  @RequirePermission("tables.manage")
  async create(@Body() body: unknown): Promise<DiningTable> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateDiningTableSchema, body);
    const table = await this.diningTablesService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toTableResponse(table);
  }

  @Patch(":id")
  @RequirePermission("tables.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<DiningTable> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(TableIdParamSchema, params);
    const request = parseOrBadRequest(UpdateDiningTableSchema, body);
    const table = await this.diningTablesService.update({ ...request, restaurantId: tenant.restaurantId, tableId: id, actorUserId: tenant.userId });
    return toTableResponse(table);
  }

  @Post(":id/regenerate-qr-code")
  @RequirePermission("tables.manage")
  async regenerateQrCode(@Param() params: unknown): Promise<DiningTable> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(TableIdParamSchema, params);
    const table = await this.diningTablesService.regenerateQrCode({ restaurantId: tenant.restaurantId, tableId: id, actorUserId: tenant.userId });
    return toTableResponse(table);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
