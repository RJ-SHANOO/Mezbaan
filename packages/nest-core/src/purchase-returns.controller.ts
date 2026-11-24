import { Body, Controller, Get, Param, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  RecordPurchaseReturnSchema,
  SetPurchaseReturnReasonCodeSchema,
  type PurchaseReturn,
  type PurchaseReturnReasonCode,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { PurchaseReturnsService, type PurchaseReturnRecord, type PurchaseReturnReasonCodeRecord } from "./purchase-returns.service.js";
import { parseOrBadRequest } from "./validation.js";

const PurchaseReturnIdParamSchema = z.object({ id: z.string().uuid() });
const PurchaseOrderIdParamSchema = z.object({ purchaseOrderId: z.string().uuid() });

function toReasonCodeResponse(reasonCode: PurchaseReturnReasonCodeRecord): PurchaseReturnReasonCode {
  return {
    id: reasonCode.id,
    code: reasonCode.code,
    label: reasonCode.label,
    isActive: reasonCode.isActive,
    createdAt: reasonCode.createdAt.toISOString(),
    updatedAt: reasonCode.updatedAt.toISOString(),
  };
}

function toReturnResponse(purchaseReturn: PurchaseReturnRecord): PurchaseReturn {
  return {
    id: purchaseReturn.id,
    branchId: purchaseReturn.branchId,
    purchaseOrderId: purchaseReturn.purchaseOrderId,
    storageLocationId: purchaseReturn.storageLocationId,
    returnedByUserId: purchaseReturn.returnedByUserId,
    note: purchaseReturn.note,
    items: purchaseReturn.items.map((item) => ({
      id: item.id,
      purchaseOrderItemId: item.purchaseOrderItemId,
      itemId: item.itemId,
      quantity: item.quantity,
      reasonCode: item.reasonCode,
      createdAt: item.createdAt.toISOString(),
    })),
    createdAt: purchaseReturn.createdAt.toISOString(),
  };
}

@Controller("purchase-return-reason-codes")
export class PurchaseReturnReasonCodesController {
  constructor(private readonly purchaseReturnsService: PurchaseReturnsService) {}

  @Get()
  @RequirePermission("purchasing.manage")
  async list(): Promise<PurchaseReturnReasonCode[]> {
    const tenant = requireTenant();
    const reasonCodes = await this.purchaseReturnsService.listReasonCodes(tenant.restaurantId);
    return reasonCodes.map(toReasonCodeResponse);
  }

  @Post()
  @RequirePermission("purchasing.manage")
  async set(@Body() body: unknown): Promise<PurchaseReturnReasonCode> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetPurchaseReturnReasonCodeSchema, body);
    const reasonCode = await this.purchaseReturnsService.setReasonCode({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toReasonCodeResponse(reasonCode);
  }
}

@Controller("purchase-returns")
export class PurchaseReturnsController {
  constructor(private readonly purchaseReturnsService: PurchaseReturnsService) {}

  @Get(":id")
  @RequirePermission("purchasing.manage")
  async get(@Param() params: unknown): Promise<PurchaseReturn> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(PurchaseReturnIdParamSchema, params);
    const purchaseReturn = await this.purchaseReturnsService.get({ restaurantId: tenant.restaurantId, purchaseReturnId: id });
    return toReturnResponse(purchaseReturn);
  }

  @Post()
  @RequirePermission("purchasing.receive")
  async record(@Body() body: unknown): Promise<PurchaseReturn> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RecordPurchaseReturnSchema, body);
    const purchaseReturn = await this.purchaseReturnsService.record({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toReturnResponse(purchaseReturn);
  }
}

@Controller("purchase-orders/:purchaseOrderId/purchase-returns")
export class PurchaseOrderPurchaseReturnsController {
  constructor(private readonly purchaseReturnsService: PurchaseReturnsService) {}

  @Get()
  @RequirePermission("purchasing.manage")
  async list(@Param() params: unknown): Promise<PurchaseReturn[]> {
    const tenant = requireTenant();
    const { purchaseOrderId } = parseOrBadRequest(PurchaseOrderIdParamSchema, params);
    const returns = await this.purchaseReturnsService.listForPurchaseOrder({ restaurantId: tenant.restaurantId, purchaseOrderId });
    return returns.map(toReturnResponse);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
