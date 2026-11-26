import { Inject, Injectable } from "@nestjs/common";
import { and, gte, lt, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";

export interface GetPlatformRevenueParams {
  from?: Date;
  to?: Date;
}

export interface PlatformRevenueByCurrencyRecord {
  currency: string;
  totalAmountMinor: bigint;
}

/**
 * P3-39: the platform's own revenue across every restaurant — summed
 * directly from commission_entries (charges and reversals together,
 * already signed — P3-34/P3-35), not from commission_runs. A run is a
 * periodic settlement artifact that lags by design (it only exists once a
 * billing cycle has fully elapsed); this is meant to answer "how much has
 * the platform actually earned" live, as of right now, so it reads the
 * same real-time ledger CommissionRunService itself aggregates from.
 */
@Injectable()
export class PlatformRevenueService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getRevenue(params: GetPlatformRevenueParams): Promise<PlatformRevenueByCurrencyRecord[]> {
    return withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const conditions = [
        params.from ? gte(schema.commissionEntries.createdAt, params.from) : undefined,
        params.to ? lt(schema.commissionEntries.createdAt, params.to) : undefined,
      ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);

      const rows = await tx
        .select({ currency: schema.commissionEntries.currency, totalMinor: sql<string>`sum(${schema.commissionEntries.amountMinor})` })
        .from(schema.commissionEntries)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(schema.commissionEntries.currency);

      return rows.map((row) => ({ currency: row.currency, totalAmountMinor: BigInt(row.totalMinor) }));
    });
  }
}
