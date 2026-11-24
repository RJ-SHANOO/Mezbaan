import { Controller, Get, Param, Body, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  ListSupplierLedgerQuerySchema,
  RecordSupplierPaymentSchema,
  type SupplierBalance,
  type SupplierLedgerEntry,
  type SupplierLedgerEntryPage,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { SupplierLedgerService, type SupplierLedgerEntryRecord } from "./supplier-ledger.service.js";
import { parseOrBadRequest } from "./validation.js";

const SupplierIdParamSchema = z.object({ supplierId: z.string().uuid() });

function toEntryResponse(entry: SupplierLedgerEntryRecord): SupplierLedgerEntry {
  return {
    id: entry.id,
    branchId: entry.branchId,
    supplierId: entry.supplierId,
    entryType: entry.entryType,
    amountMinor: entry.amountMinor.toString(),
    currency: entry.currency,
    supplierInvoiceId: entry.supplierInvoiceId,
    note: entry.note,
    actorUserId: entry.actorUserId,
    createdAt: entry.createdAt.toISOString(),
  };
}

@Controller("suppliers/:supplierId/ledger")
export class SupplierLedgerController {
  constructor(private readonly supplierLedgerService: SupplierLedgerService) {}

  @Get("balance")
  @RequirePermission("suppliers.manage")
  async getBalance(@Param() params: unknown): Promise<SupplierBalance> {
    const tenant = requireTenant();
    const { supplierId } = parseOrBadRequest(SupplierIdParamSchema, params);
    const balance = await this.supplierLedgerService.getBalance({ restaurantId: tenant.restaurantId, supplierId });
    return { balanceMinor: balance.balanceMinor.toString(), currency: balance.currency };
  }

  @Get()
  @RequirePermission("suppliers.manage")
  async list(@Param() params: unknown, @Query() query: unknown): Promise<SupplierLedgerEntryPage> {
    const tenant = requireTenant();
    const { supplierId } = parseOrBadRequest(SupplierIdParamSchema, params);
    const request = parseOrBadRequest(ListSupplierLedgerQuerySchema, query);
    const page = await this.supplierLedgerService.listLedger({ restaurantId: tenant.restaurantId, supplierId, ...request });
    return { items: page.items.map(toEntryResponse), nextCursor: page.nextCursor };
  }

  @Post("payments")
  @RequirePermission("suppliers.manage")
  async recordPayment(@Param() params: unknown, @Body() body: unknown): Promise<SupplierLedgerEntry> {
    const tenant = requireTenant();
    const { supplierId } = parseOrBadRequest(SupplierIdParamSchema, params);
    const request = parseOrBadRequest(RecordSupplierPaymentSchema, body);
    const entry = await this.supplierLedgerService.recordPayment({
      ...request,
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      supplierId,
      amountMinor: BigInt(request.amountMinor),
    });
    return toEntryResponse(entry);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
