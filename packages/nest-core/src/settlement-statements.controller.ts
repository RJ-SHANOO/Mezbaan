import { Body, Controller, ForbiddenException, Get, Param, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  RecordSettlementPaymentSchema,
  type SettlementBalance,
  type SettlementPayment,
  type SettlementStatement,
} from "@mezbaan/contracts";
import {
  SettlementStatementsService,
  type SettlementBalance as SettlementBalanceRecord,
  type SettlementPaymentRecord,
  type SettlementStatementRecord,
} from "./settlement-statements.service.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

const RestaurantIdParamSchema = z.object({ restaurantId: z.string().uuid() });
const StatementIdParamSchema = z.object({ statementId: z.string().uuid() });
const RestaurantAndStatementParamSchema = z.object({ restaurantId: z.string().uuid(), statementId: z.string().uuid() });

function toStatementResponse(statement: SettlementStatementRecord): SettlementStatement {
  return {
    id: statement.id,
    restaurantId: statement.restaurantId,
    commissionRunId: statement.commissionRunId,
    periodStart: statement.periodStart.toISOString(),
    periodEnd: statement.periodEnd.toISOString(),
    totalAmountMinor: statement.totalAmountMinor.toString(),
    currency: statement.currency,
    createdAt: statement.createdAt.toISOString(),
  };
}

function toBalanceResponse(balance: SettlementBalanceRecord): SettlementBalance {
  return {
    totalAmountMinor: balance.totalAmountMinor.toString(),
    paidAmountMinor: balance.paidAmountMinor.toString(),
    remainingAmountMinor: balance.remainingAmountMinor.toString(),
    currency: balance.currency,
  };
}

function toPaymentResponse(payment: SettlementPaymentRecord): SettlementPayment {
  return {
    id: payment.id,
    settlementStatementId: payment.settlementStatementId,
    amountMinor: payment.amountMinor.toString(),
    currency: payment.currency,
    reference: payment.reference,
    recordedByUserId: payment.recordedByUserId,
    createdAt: payment.createdAt.toISOString(),
  };
}

/** P3-38: same transparency-for-the-restaurant / write-is-super-admin-only
 * split as BillingPlanController and FeatureFlagsController. */
@Controller()
export class SettlementStatementsController {
  constructor(private readonly settlementStatementsService: SettlementStatementsService) {}

  @Get("settlement-statements")
  async listMine(): Promise<SettlementStatement[]> {
    const tenant = requireTenant();
    const statements = await this.settlementStatementsService.listForRestaurant(tenant.restaurantId);
    return statements.map(toStatementResponse);
  }

  @Get("settlement-statements/:statementId/balance")
  async getMyBalance(@Param() params: unknown): Promise<SettlementBalance> {
    const tenant = requireTenant();
    const { statementId } = parseOrBadRequest(StatementIdParamSchema, params);
    const balance = await this.settlementStatementsService.getBalance({ restaurantId: tenant.restaurantId, statementId });
    return toBalanceResponse(balance);
  }

  @Get("settlement-statements/:statementId/payments")
  async listMyPayments(@Param() params: unknown): Promise<SettlementPayment[]> {
    const tenant = requireTenant();
    const { statementId } = parseOrBadRequest(StatementIdParamSchema, params);
    const payments = await this.settlementStatementsService.listPayments({ restaurantId: tenant.restaurantId, statementId });
    return payments.map(toPaymentResponse);
  }

  @Get("restaurants/:restaurantId/settlement-statements")
  async listForRestaurant(@Param() params: unknown): Promise<SettlementStatement[]> {
    requireSuperAdmin();
    const { restaurantId } = parseOrBadRequest(RestaurantIdParamSchema, params);
    const statements = await this.settlementStatementsService.listForRestaurantAsSuperAdmin(restaurantId);
    return statements.map(toStatementResponse);
  }

  @Get("restaurants/:restaurantId/settlement-statements/:statementId/balance")
  async getBalanceAsSuperAdmin(@Param() params: unknown): Promise<SettlementBalance> {
    requireSuperAdmin();
    const { restaurantId, statementId } = parseOrBadRequest(RestaurantAndStatementParamSchema, params);
    const balance = await this.settlementStatementsService.getBalance({ restaurantId, statementId, asSuperAdmin: true });
    return toBalanceResponse(balance);
  }

  @Get("restaurants/:restaurantId/settlement-statements/:statementId/payments")
  async listPaymentsAsSuperAdmin(@Param() params: unknown): Promise<SettlementPayment[]> {
    requireSuperAdmin();
    const { restaurantId, statementId } = parseOrBadRequest(RestaurantAndStatementParamSchema, params);
    const payments = await this.settlementStatementsService.listPayments({ restaurantId, statementId, asSuperAdmin: true });
    return payments.map(toPaymentResponse);
  }

  @Post("restaurants/:restaurantId/settlement-statements/:statementId/payments")
  async recordPayment(@Param() params: unknown, @Body() body: unknown): Promise<SettlementPayment> {
    const actor = requireSuperAdmin();
    const { restaurantId, statementId } = parseOrBadRequest(RestaurantAndStatementParamSchema, params);
    const input = parseOrBadRequest(RecordSettlementPaymentSchema, body);
    const payment = await this.settlementStatementsService.recordPayment({
      restaurantId,
      statementId,
      actorUserId: actor.userId,
      amountMinor: BigInt(input.amountMinor),
      currency: input.currency,
      reference: input.reference,
    });
    return toPaymentResponse(payment);
  }
}

function requireTenant(): { restaurantId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId };
}

/** No @RequirePermission/role-seed for this: a super-admin token already
 * bypasses PermissionGuard entirely, and these write routes must never be
 * reachable by anyone else — including an Owner, same reasoning as
 * FeatureFlagsController/BillingPlanController's own requireSuperAdmin. */
function requireSuperAdmin(): { userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  if (!tenant.isSuperAdmin) {
    throw new ForbiddenException("Super admin access required");
  }
  return { userId: tenant.userId };
}
