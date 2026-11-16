import { Body, Controller, Get, Param, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { ChargeCreditSchema, RecordRepaymentSchema, type CreditBalance, type CreditCustomer, type CreditLedgerEntry } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { CreditCustomersService, type CreditBalance as CreditBalanceRecord, type CreditCustomerRecord, type CreditLedgerEntryRecord } from "./credit-customers.service.js";
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

function toBalanceResponse(balance: CreditBalanceRecord): CreditBalance {
  return { creditLimitMinor: balance.creditLimitMinor.toString(), balanceMinor: balance.balanceMinor.toString(), availableCreditMinor: balance.availableCreditMinor.toString() };
}

function toEntryResponse(entry: CreditLedgerEntryRecord): CreditLedgerEntry {
  return {
    id: entry.id,
    creditCustomerId: entry.creditCustomerId,
    entryType: entry.entryType,
    amountMinor: entry.amountMinor.toString(),
    currency: entry.currency,
    invoiceId: entry.invoiceId,
    note: entry.note,
    actorUserId: entry.actorUserId,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** P2-25, POS side: read-only lookup (to pick a customer at the till) plus
 * charging/repaying their account — gated by pos.sell like any other
 * sale-time billing action, same tier as recording a payment. Lives in
 * api-pos's OrdersModule, its own copy of CreditCustomersService, same
 * convention as every other shared stateless service in this codebase. */
@Controller("credit-customers")
export class CreditCustomerLookupController {
  constructor(private readonly creditCustomersService: CreditCustomersService) {}

  @Get()
  @RequirePermission("pos.sell")
  async list(): Promise<CreditCustomer[]> {
    const tenant = requireTenant();
    const customers = await this.creditCustomersService.list(tenant.restaurantId);
    return customers.map(toCustomerResponse);
  }
}

@Controller("credit-customers/:id")
export class CreditAccountController {
  constructor(private readonly creditCustomersService: CreditCustomersService) {}

  @Get("balance")
  @RequirePermission("pos.sell")
  async getBalance(@Param() params: unknown): Promise<CreditBalance> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(CustomerIdParamSchema, params);
    const balance = await this.creditCustomersService.getBalance({ restaurantId: tenant.restaurantId, creditCustomerId: id });
    return toBalanceResponse(balance);
  }

  @Get("ledger")
  @RequirePermission("pos.sell")
  async listLedger(@Param() params: unknown): Promise<CreditLedgerEntry[]> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(CustomerIdParamSchema, params);
    const entries = await this.creditCustomersService.listLedger({ restaurantId: tenant.restaurantId, creditCustomerId: id });
    return entries.map(toEntryResponse);
  }

  @Post("charges")
  @RequirePermission("pos.sell")
  async charge(@Param() params: unknown, @Body() body: unknown): Promise<CreditLedgerEntry> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(CustomerIdParamSchema, params);
    const request = parseOrBadRequest(ChargeCreditSchema, body);
    const entry = await this.creditCustomersService.chargeInvoice({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      creditCustomerId: id,
      amountMinor: BigInt(request.amountMinor),
      invoiceId: request.invoiceId,
      note: request.note,
    });
    return toEntryResponse(entry);
  }

  @Post("repayments")
  @RequirePermission("pos.sell")
  async repay(@Param() params: unknown, @Body() body: unknown): Promise<CreditLedgerEntry> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(CustomerIdParamSchema, params);
    const request = parseOrBadRequest(RecordRepaymentSchema, body);
    const entry = await this.creditCustomersService.recordRepayment({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      creditCustomerId: id,
      amountMinor: BigInt(request.amountMinor),
      note: request.note,
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
