import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateProductVariantSchema, UpdateProductVariantSchema, type ProductVariant } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ProductVariantsService, type ProductVariantRecord } from "./product-variants.service.js";
import { parseOrBadRequest } from "./validation.js";

const ProductIdParamSchema = z.object({ productId: z.string().uuid() });
const VariantIdParamSchema = z.object({ productId: z.string().uuid(), variantId: z.string().uuid() });

function toVariantResponse(variant: ProductVariantRecord): ProductVariant {
  return {
    id: variant.id,
    productId: variant.productId,
    name: variant.name,
    sku: variant.sku,
    barcode: variant.barcode,
    sortOrder: variant.sortOrder,
    status: variant.status,
    createdAt: variant.createdAt.toISOString(),
    updatedAt: variant.updatedAt.toISOString(),
  };
}

@Controller("products/:productId/variants")
export class ProductVariantsController {
  constructor(private readonly productVariantsService: ProductVariantsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(@Param() params: unknown): Promise<ProductVariant[]> {
    const tenant = requireTenant();
    const { productId } = parseOrBadRequest(ProductIdParamSchema, params);
    const variants = await this.productVariantsService.list(tenant.restaurantId, productId);
    return variants.map(toVariantResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Param() params: unknown, @Body() body: unknown): Promise<ProductVariant> {
    const tenant = requireTenant();
    const { productId } = parseOrBadRequest(ProductIdParamSchema, params);
    const request = parseOrBadRequest(CreateProductVariantSchema, body);
    const variant = await this.productVariantsService.create({
      ...request,
      restaurantId: tenant.restaurantId,
      productId,
      actorUserId: tenant.userId,
    });
    return toVariantResponse(variant);
  }

  @Patch(":variantId")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ProductVariant> {
    const tenant = requireTenant();
    const { variantId } = parseOrBadRequest(VariantIdParamSchema, params);
    const request = parseOrBadRequest(UpdateProductVariantSchema, body);
    const variant = await this.productVariantsService.update({
      ...request,
      restaurantId: tenant.restaurantId,
      variantId,
      actorUserId: tenant.userId,
    });
    return toVariantResponse(variant);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
