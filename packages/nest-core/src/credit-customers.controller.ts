import { Body, Controller, Get, Param, Post, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  CreateCreditCustomerSchema,
  UpdateCreditCustomerSchema,
  type CreditCustomer,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { CreditCustomersService, type CreditCustomerRecord } from "./credit-customers.service.js";
import { parseOrBadRequest } from "./validation.js";

const CustomerIdParamSchema = z.object({ id: z.string().uuid() });

function toCustomerResponse(row: CreditCustomerRecord): CreditCustomer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    creditLimitMinor: row.creditLimitMinor.toString(),
    currency: row.currency,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** P2-25, admin side: creating a credit customer and setting their credit
 * limit is a restaurant-admin action, gated by the new credit.manage
 * permission (same tier as menu.manage/tables.manage) — not pos.sell, since
 * this is account setup, not a sale-time action. Lives in api-admin's
 * CatalogModule, same "each module provides its own service copy"
 * convention as discounts/voids/refunds. */
@Controller("credit-customers")
export class CreditCustomersController {
  constructor(private readonly creditCustomersService: CreditCustomersService) {}

  @Get()
  @RequirePermission("credit.manage")
  async list(): Promise<CreditCustomer[]> {
    const tenant = requireTenant();
    const customers = await this.creditCustomersService.list(tenant.restaurantId);
    return customers.map(toCustomerResponse);
  }

  @Get(":id")
  @RequirePermission("credit.manage")
  async get(@Param() params: unknown): Promise<CreditCustomer> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(CustomerIdParamSchema, params);
    const customer = await this.creditCustomersService.get(tenant.restaurantId, id);
    return toCustomerResponse(customer);
  }

  @Post()
  @RequirePermission("credit.manage")
  async create(@Body() body: unknown): Promise<CreditCustomer> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateCreditCustomerSchema, body);
    const customer = await this.creditCustomersService.create({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      name: request.name,
      phone: request.phone,
      creditLimitMinor: request.creditLimitMinor !== undefined ? BigInt(request.creditLimitMinor) : undefined,
      currency: request.currency,
    });
    return toCustomerResponse(customer);
  }

  @Put(":id")
  @RequirePermission("credit.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<CreditCustomer> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(CustomerIdParamSchema, params);
    const request = parseOrBadRequest(UpdateCreditCustomerSchema, body);
    const customer = await this.creditCustomersService.update({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      creditCustomerId: id,
      name: request.name,
      phone: request.phone,
      creditLimitMinor: request.creditLimitMinor !== undefined ? BigInt(request.creditLimitMinor) : undefined,
      isActive: request.isActive,
    });
    return toCustomerResponse(customer);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
