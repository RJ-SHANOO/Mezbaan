import { Body, Controller, Get, Param, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  RecordGoodsReceivedNoteSchema,
  SetGoodsRejectionReasonCodeSchema,
  type GoodsReceivedNote,
  type GoodsRejectionReasonCode,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { GoodsReceivedNotesService, type GoodsReceivedNoteRecord, type GoodsRejectionReasonCodeRecord } from "./goods-received-notes.service.js";
import { parseOrBadRequest } from "./validation.js";

const GoodsReceivedNoteIdParamSchema = z.object({ id: z.string().uuid() });
const PurchaseOrderIdParamSchema = z.object({ purchaseOrderId: z.string().uuid() });

function toReasonCodeResponse(reasonCode: GoodsRejectionReasonCodeRecord): GoodsRejectionReasonCode {
  return {
    id: reasonCode.id,
    code: reasonCode.code,
    label: reasonCode.label,
    isActive: reasonCode.isActive,
    createdAt: reasonCode.createdAt.toISOString(),
    updatedAt: reasonCode.updatedAt.toISOString(),
  };
}

function toNoteResponse(note: GoodsReceivedNoteRecord): GoodsReceivedNote {
  return {
    id: note.id,
    branchId: note.branchId,
    purchaseOrderId: note.purchaseOrderId,
    storageLocationId: note.storageLocationId,
    receivedByUserId: note.receivedByUserId,
    note: note.note,
    items: note.items.map((item) => ({
      id: item.id,
      purchaseOrderItemId: item.purchaseOrderItemId,
      itemId: item.itemId,
      deliveredQuantity: item.deliveredQuantity,
      rejectedQuantity: item.rejectedQuantity,
      acceptedQuantity: item.acceptedQuantity,
      rejectionReasonCode: item.rejectionReasonCode,
      invoicedUnitCostMinor: item.invoicedUnitCostMinor.toString(),
      orderedUnitCostMinor: item.orderedUnitCostMinor.toString(),
      priceDifferenceMinor: item.priceDifferenceMinor.toString(),
      currency: item.currency,
      createdAt: item.createdAt.toISOString(),
    })),
    createdAt: note.createdAt.toISOString(),
  };
}

@Controller("goods-rejection-reason-codes")
export class GoodsRejectionReasonCodesController {
  constructor(private readonly goodsReceivedNotesService: GoodsReceivedNotesService) {}

  @Get()
  @RequirePermission("purchasing.manage")
  async list(): Promise<GoodsRejectionReasonCode[]> {
    const tenant = requireTenant();
    const reasonCodes = await this.goodsReceivedNotesService.listReasonCodes(tenant.restaurantId);
    return reasonCodes.map(toReasonCodeResponse);
  }

  @Post()
  @RequirePermission("purchasing.manage")
  async set(@Body() body: unknown): Promise<GoodsRejectionReasonCode> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetGoodsRejectionReasonCodeSchema, body);
    const reasonCode = await this.goodsReceivedNotesService.setReasonCode({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toReasonCodeResponse(reasonCode);
  }
}

@Controller("goods-received-notes")
export class GoodsReceivedNotesController {
  constructor(private readonly goodsReceivedNotesService: GoodsReceivedNotesService) {}

  @Get(":id")
  @RequirePermission("purchasing.manage")
  async get(@Param() params: unknown): Promise<GoodsReceivedNote> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(GoodsReceivedNoteIdParamSchema, params);
    const note = await this.goodsReceivedNotesService.get({ restaurantId: tenant.restaurantId, goodsReceivedNoteId: id });
    return toNoteResponse(note);
  }

  @Post()
  @RequirePermission("purchasing.receive")
  async record(@Body() body: unknown): Promise<GoodsReceivedNote> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RecordGoodsReceivedNoteSchema, body);
    const note = await this.goodsReceivedNotesService.record({
      ...request,
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      items: request.items.map((item) => ({ ...item, invoicedUnitCostMinor: BigInt(item.invoicedUnitCostMinor) })),
    });
    return toNoteResponse(note);
  }
}

@Controller("purchase-orders/:purchaseOrderId/goods-received-notes")
export class PurchaseOrderGoodsReceivedNotesController {
  constructor(private readonly goodsReceivedNotesService: GoodsReceivedNotesService) {}

  @Get()
  @RequirePermission("purchasing.manage")
  async list(@Param() params: unknown): Promise<GoodsReceivedNote[]> {
    const tenant = requireTenant();
    const { purchaseOrderId } = parseOrBadRequest(PurchaseOrderIdParamSchema, params);
    const notes = await this.goodsReceivedNotesService.listForPurchaseOrder({ restaurantId: tenant.restaurantId, purchaseOrderId });
    return notes.map(toNoteResponse);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
