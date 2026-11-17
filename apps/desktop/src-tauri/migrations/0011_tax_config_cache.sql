-- P2-45: the terminal's local cache of each order type's already-resolved
-- tax/service-charge config (P1-27's snapshot, "menu" section's new
-- `taxConfig` array) — same wholesale-replace-on-sync convention as
-- 0005_menu_cache.sql, so an offline sale can price itself without a
-- server round-trip (packages/domain's computeCharges, given this config
-- plus a subtotal, produces exactly the number the server would have).
CREATE TABLE tax_config (
    order_type TEXT PRIMARY KEY,
    pricing_mode TEXT NOT NULL,
    tax_rate_basis_points INTEGER NOT NULL,
    service_charge_rate_basis_points INTEGER,
    service_charge_is_taxable INTEGER
);

-- One row per stacked tax rule within an order type's config, purely for
-- receipt line-item display (rendering "GST (10.00%): 2000" per rule) —
-- computeCharges itself only ever needs the already-summed
-- tax_rate_basis_points above, never this breakdown.
CREATE TABLE tax_config_applied_rules (
    order_type TEXT NOT NULL,
    name TEXT NOT NULL,
    rate_basis_points INTEGER NOT NULL
);
CREATE INDEX tax_config_applied_rules_order_type_idx ON tax_config_applied_rules (order_type);
