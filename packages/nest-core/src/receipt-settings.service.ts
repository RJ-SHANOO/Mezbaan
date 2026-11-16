import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ReceiptSettingsRecord {
  logoUrl: string | null;
  headerText: string | null;
  footerText: string | null;
  showTaxBreakdown: boolean;
  showServiceCharge: boolean;
  updatedAt: Date;
}

export interface SetReceiptSettingsParams {
  restaurantId: string;
  actorUserId: string;
  logoUrl?: string | null;
  headerText?: string | null;
  footerText?: string | null;
  showTaxBreakdown?: boolean;
  showServiceCharge?: boolean;
}

const DEFAULTS: ReceiptSettingsRecord = {
  logoUrl: null,
  headerText: null,
  footerText: null,
  showTaxBreakdown: true,
  showServiceCharge: true,
  updatedAt: new Date(0),
};

/**
 * P2-33: what a restaurant's receipt looks like — logo reference, header/
 * footer text, and whether the tax breakdown / service charge line show at
 * all. One row per restaurant, same "settings value, not a historical
 * record" upsert shape as TaxSettingsService.set. A restaurant that hasn't
 * configured this yet gets sensible defaults (both breakdowns shown, no
 * logo, no custom text) rather than an error — nothing here is sensitive
 * enough to need an explicit opt-in.
 */
@Injectable()
export class ReceiptSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async get(restaurantId: string): Promise<ReceiptSettingsRecord> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.receiptSettings).where(eq(schema.receiptSettings.restaurantId, restaurantId));
      return rows[0] ?? DEFAULTS;
    });
  }

  async set(params: SetReceiptSettingsParams): Promise<ReceiptSettingsRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.receiptSettings).where(eq(schema.receiptSettings.restaurantId, params.restaurantId));
      const existing = existingRows[0];

      const values = {
        logoUrl: params.logoUrl !== undefined ? params.logoUrl : existing?.logoUrl ?? null,
        headerText: params.headerText !== undefined ? params.headerText : existing?.headerText ?? null,
        footerText: params.footerText !== undefined ? params.footerText : existing?.footerText ?? null,
        showTaxBreakdown: params.showTaxBreakdown ?? existing?.showTaxBreakdown ?? true,
        showServiceCharge: params.showServiceCharge ?? existing?.showServiceCharge ?? true,
      };

      const rows = existing
        ? await tx
            .update(schema.receiptSettings)
            .set({ ...values, updatedByUserId: params.actorUserId, updatedAt: new Date() })
            .where(eq(schema.receiptSettings.id, existing.id))
            .returning()
        : await tx
            .insert(schema.receiptSettings)
            .values({ restaurantId: params.restaurantId, ...values, updatedByUserId: params.actorUserId })
            .returning();
      const settings = rows[0];
      if (!settings) throw new Error("set: receipt settings upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "receipt_settings.set", targetType: "receipt_settings", targetId: settings.id },
        tx,
      );
      return settings;
    });
  }
}
