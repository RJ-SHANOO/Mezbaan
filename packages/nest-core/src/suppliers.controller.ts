import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateSupplierSchema, UpdateSupplierSchema, type Supplier } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { SuppliersService, type SupplierRecord } from "./suppliers.service.js";
import { parseOrBadRequest } from "./validation.js";

const SupplierIdParamSchema = z.object({ id: z.string().uuid() });

function toSupplierResponse(supplier: SupplierRecord): Supplier {
  return {
    id: supplier.id,
    name: supplier.name,
    contactName: supplier.contactName,
    phone: supplier.phone,
    email: supplier.email,
    address: supplier.address,
    status: supplier.status,
    createdAt: supplier.createdAt.toISOString(),
    updatedAt: supplier.updatedAt.toISOString(),
  };
}

@Controller("suppliers")
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @RequirePermission("suppliers.manage")
  async list(): Promise<Supplier[]> {
    const tenant = requireTenant();
    const suppliers = await this.suppliersService.list(tenant.restaurantId);
    return suppliers.map(toSupplierResponse);
  }

  @Get(":id")
  @RequirePermission("suppliers.manage")
  async get(@Param() params: unknown): Promise<Supplier> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(SupplierIdParamSchema, params);
    const supplier = await this.suppliersService.get({ restaurantId: tenant.restaurantId, supplierId: id });
    return toSupplierResponse(supplier);
  }

  @Post()
  @RequirePermission("suppliers.manage")
  async create(@Body() body: unknown): Promise<Supplier> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateSupplierSchema, body);
    const supplier = await this.suppliersService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toSupplierResponse(supplier);
  }

  @Patch(":id")
  @RequirePermission("suppliers.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<Supplier> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(SupplierIdParamSchema, params);
    const request = parseOrBadRequest(UpdateSupplierSchema, body);
    const supplier = await this.suppliersService.update({ ...request, restaurantId: tenant.restaurantId, supplierId: id, actorUserId: tenant.userId });
    return toSupplierResponse(supplier);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
