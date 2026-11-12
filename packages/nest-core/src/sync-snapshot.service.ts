import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import type { OrderType, SnapshotContent, SnapshotMenu, SyncSnapshotResponse } from "@mezbaan/contracts";
import { DATABASE } from "./db.module.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { signBytes } from "./snapshot-signing.js";

const ORDER_TYPES: readonly OrderType[] = ["dine_in", "takeaway", "delivery"];

/**
 * Downstream sync (P1-27): builds a versioned, signed snapshot of whatever a
 * terminal needs to keep working offline. Staff/branches stay restaurant-
 * wide (unchanged since P1-27); the menu section added here (P2-11) is
 * scoped to the one branch the requesting device is paired to — see
 * SnapshotMenuSchema in contracts for why.
 *
 * Signed over contentJson's exact bytes (see snapshot-signing.ts) so the client
 * verifies against the literal string it received — never a re-serialization of
 * the parsed object, which Rust and JS wouldn't promise byte-for-byte anyway.
 */
@Injectable()
export class SyncSnapshotService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly priceResolutionService: PriceResolutionService,
  ) {}

  async buildSnapshot(restaurantId: string, branchId: string): Promise<SyncSnapshotResponse> {
    const content = await this.loadContent(restaurantId, branchId);
    const contentJson = JSON.stringify(content);
    return {
      version: new Date().toISOString(),
      contentJson,
      signature: signBytes(contentJson),
    };
  }

  private async loadContent(restaurantId: string, branchId: string): Promise<SnapshotContent> {
    const { branches, staff } = await withTenant(this.db, { restaurantId }, async (tx) => {
      const branches = await tx
        .select({ id: schema.branches.id, name: schema.branches.name, timezone: schema.branches.timezone, status: schema.branches.status })
        .from(schema.branches);

      const staff = await tx
        .select({
          id: schema.users.id,
          displayName: schema.users.displayName,
          email: schema.users.email,
          roleKey: schema.roles.key,
          branchId: schema.users.branchId,
          status: schema.users.status,
          pinHash: schema.managerPins.pinHash,
        })
        .from(schema.users)
        .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
        .leftJoin(schema.managerPins, eq(schema.managerPins.userId, schema.users.id));

      return { branches, staff: staff.map((row) => ({ ...row, pinHash: row.pinHash ?? null })) };
    });

    const menu = await this.loadMenu(restaurantId, branchId);
    return { restaurantId, branches, staff, menu };
  }

  private async loadMenu(restaurantId: string, branchId: string): Promise<SnapshotMenu> {
    const { categories, products, variants } = await withTenant(this.db, { restaurantId }, async (tx) => {
      const categories = await tx
        .select({ id: schema.categories.id, name: schema.categories.name, sortOrder: schema.categories.sortOrder })
        .from(schema.categories)
        .where(eq(schema.categories.status, "active"));

      const allActiveProducts = await tx
        .select({
          id: schema.products.id,
          categoryId: schema.products.categoryId,
          name: schema.products.name,
          sku: schema.products.sku,
          barcode: schema.products.barcode,
          imageUrl: schema.products.imageUrl,
          sortOrder: schema.products.sortOrder,
        })
        .from(schema.products)
        .where(eq(schema.products.status, "active"));

      // product_branch_availability is an exclusion list (P2-01) — a row only
      // exists to record an override, so "available" here still has to be read
      // off the row, not assumed from its mere presence.
      const overrides = await tx
        .select({ productId: schema.productBranchAvailability.productId, available: schema.productBranchAvailability.available })
        .from(schema.productBranchAvailability)
        .where(eq(schema.productBranchAvailability.branchId, branchId));
      const unavailableProductIds = new Set(overrides.filter((row) => !row.available).map((row) => row.productId));

      const products = allActiveProducts.filter((product) => !unavailableProductIds.has(product.id));

      const variants =
        products.length === 0
          ? []
          : await tx.select({
              id: schema.productVariants.id,
              productId: schema.productVariants.productId,
              name: schema.productVariants.name,
              sku: schema.productVariants.sku,
              barcode: schema.productVariants.barcode,
              sortOrder: schema.productVariants.sortOrder,
            }).from(schema.productVariants).where(eq(schema.productVariants.status, "active"));

      return { categories, products, variants: variants.filter((variant) => products.some((product) => product.id === variant.productId)) };
    });

    const prices: SnapshotMenu["prices"] = [];
    for (const orderType of ORDER_TYPES) {
      for (const product of products) {
        const resolved = await this.priceResolutionService.resolvePrice({ restaurantId, branchId, orderType, productId: product.id });
        if (resolved) {
          prices.push({
            productId: product.id,
            orderType,
            unitPriceMinor: resolved.unitPriceMinor.toString(),
            currency: resolved.currency,
            priceListId: resolved.priceListId,
            priceListVersion: resolved.version,
          });
        }
      }
      for (const variant of variants) {
        const resolved = await this.priceResolutionService.resolvePrice({ restaurantId, branchId, orderType, variantId: variant.id });
        if (resolved) {
          prices.push({
            variantId: variant.id,
            orderType,
            unitPriceMinor: resolved.unitPriceMinor.toString(),
            currency: resolved.currency,
            priceListId: resolved.priceListId,
            priceListVersion: resolved.version,
          });
        }
      }
    }

    return { branchId, categories, products, variants, prices };
  }
}
