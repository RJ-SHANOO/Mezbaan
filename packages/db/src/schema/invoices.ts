import { bigint, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { devices } from "./devices.js";
import { orders } from "./orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-18: the first real financial-ledger entity (rule 4: append-only, same
 * enforcement as audit_logs/order_status_history — app-role.ts REVOKEs
 * UPDATE/DELETE from mezbaan_app). One row per order, generated once the
 * order is closed (OrdersService.close, P2-13) — InvoicesService.generate
 * rejects a second invoice for the same orderId outright rather than
 * "correcting" one in place; a real correction is a future compensating
 * document (refund/credit-note territory, P2-24), not an update here.
 *
 * `documentNumber` follows rule 10's "B{branch_number}-T{terminal_number}-
 * {sequence:06}" format, but the trailing sequence here comes from a new
 * per-device counter (devices.nextInvoiceSequence) — a deliberately separate
 * counter from P1-28's desktop-local SQLite one, not a shared one. There is
 * no real offline terminal sales flow yet for that local counter to serve
 * (no login/cart-to-server wiring exists on desktop — see P2-12's notes), so
 * today every real invoice is generated through this server path. Reconciling
 * the two counters into one true per-terminal series is deferred to whichever
 * task actually builds that offline flow — documented here so it isn't
 * silently forgotten, not because it's unimportant.
 *
 * Money fields are bigint minor units (rule 5), computed purely through
 * packages/domain via TaxCalculationService.previewCharges (P2-05) over the
 * order's own already price-list-versioned items (P2-12) — this task adds no
 * new pricing or re-resolution step of its own, only persists the result.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id),
    documentNumber: text("document_number").notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).notNull(),
    serviceChargeMinor: bigint("service_charge_minor", { mode: "bigint" }).notNull(),
    taxMinor: bigint("tax_minor", { mode: "bigint" }).notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    pricingMode: text("pricing_mode", { enum: ["inclusive", "exclusive"] }).notNull(),
    taxRateBasisPoints: integer("tax_rate_basis_points").notNull(),
    serviceChargeRateBasisPoints: integer("service_charge_rate_basis_points"),
    // [{ name, rateBasisPoints }] — the actual stacked tax rules applied (TaxRulesService.AppliedTaxRule),
    // kept for audit/receipt-printing even if a rule's own configuration changes later.
    appliedTaxRules: jsonb("applied_tax_rules").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One invoice per order (append-only — no regenerating a second one over it).
    uniqueIndex("invoices_order_id_idx").on(table.orderId),
    // Defense in depth, same reasoning as every other generated-number uniqueness
    // guarantee in this codebase: the branch/terminal/sequence combination should
    // already be unique by construction, but a real DB constraint is the actual
    // guarantee, not just the service's own good behavior. Scoped by restaurantId,
    // not global — branchNumber/terminalNumber are each only unique within their
    // own restaurant/branch (see branches.ts/devices.ts), so two different
    // restaurants' first branch and first device both legitimately produce
    // "B1-T1-000001".
    uniqueIndex("invoices_restaurant_document_number_idx").on(table.restaurantId, table.documentNumber),
    pgPolicy("invoices_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
