import { Body, Controller, Get, Param, Patch, Post, Put, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  CreateProductSchema,
  SetProductBranchAvailabilitySchema,
  UpdateProductSchema,
  type Product,
  type ProductBranchAvailability,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ProductsService, type ProductBranchAvailabilityRecord, type ProductRecord } from "./products.service.js";
import { parseOrBadRequest } from "./validation.js";

const ProductIdParamSchema = z.object({ id: z.string().uuid() });
const ListProductsQuerySchema = z.object({ categoryId: z.string().uuid().optional() });

function toProductResponse(product: ProductRecord): Product {
  return {
    id: product.id,
    categoryId: product.categoryId,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    sortOrder: product.sortOrder,
    status: product.status,
    imageUrl: product.imageUrl,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

function toAvailabilityResponse(record: ProductBranchAvailabilityRecord): ProductBranchAvailability {
  return { branchId: record.branchId, available: record.available };
}

@Controller("products")
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(@Query() query: unknown): Promise<Product[]> {
    const tenant = requireTenant();
    const { categoryId } = parseOrBadRequest(ListProductsQuerySchema, query);
    const products = await this.productsService.list(tenant.restaurantId, categoryId);
    return products.map(toProductResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Body() body: unknown): Promise<Product> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateProductSchema, body);
    const product = await this.productsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toProductResponse(product);
  }

  @Patch(":id")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<Product> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ProductIdParamSchema, params);
    const request = parseOrBadRequest(UpdateProductSchema, body);
    const product = await this.productsService.update({
      ...request,
      restaurantId: tenant.restaurantId,
      productId: id,
      actorUserId: tenant.userId,
    });
    return toProductResponse(product);
  }

  @Get(":id/availability")
  @RequirePermission("menu.manage")
  async listAvailability(@Param() params: unknown): Promise<ProductBranchAvailability[]> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ProductIdParamSchema, params);
    const records = await this.productsService.listBranchAvailability(tenant.restaurantId, id);
    return records.map(toAvailabilityResponse);
  }

  @Put(":id/availability")
  @RequirePermission("menu.manage")
  async setAvailability(@Param() params: unknown, @Body() body: unknown): Promise<ProductBranchAvailability> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ProductIdParamSchema, params);
    const request = parseOrBadRequest(SetProductBranchAvailabilitySchema, body);
    await this.productsService.setBranchAvailability({
      ...request,
      restaurantId: tenant.restaurantId,
      productId: id,
      actorUserId: tenant.userId,
    });
    return { branchId: request.branchId, available: request.available };
  }
}

/** Same narrowing helper as CategoriesController — PermissionGuard already
 * requires authentication for every route here. */
function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
