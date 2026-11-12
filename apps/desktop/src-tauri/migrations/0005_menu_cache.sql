-- P2-11: the terminal's local menu cache, synced down from P1-27's signed
-- snapshot (menu_cache.rs ingests it). Wholesale replace on every sync, same
-- "server's version wins" rule as offline_staff — never a merge.
CREATE TABLE menu_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL
);

CREATE TABLE menu_products (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sku TEXT,
    barcode TEXT,
    image_url TEXT,
    sort_order INTEGER NOT NULL
);
CREATE INDEX menu_products_category_id_idx ON menu_products (category_id);
CREATE INDEX menu_products_barcode_idx ON menu_products (barcode);
CREATE INDEX menu_products_sku_idx ON menu_products (sku);

CREATE TABLE menu_variants (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sku TEXT,
    barcode TEXT,
    sort_order INTEGER NOT NULL
);
CREATE INDEX menu_variants_product_id_idx ON menu_variants (product_id);
CREATE INDEX menu_variants_barcode_idx ON menu_variants (barcode);

-- One row per (item, order_type) that has a resolved price — exactly one of
-- product_id/variant_id is set, same convention as the server's
-- price_list_items. Missing a row for a combination means "not priced yet,"
-- not an error (see SnapshotMenuSchema in contracts).
CREATE TABLE menu_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT,
    variant_id TEXT,
    order_type TEXT NOT NULL,
    unit_price_minor TEXT NOT NULL,
    currency TEXT NOT NULL,
    price_list_id TEXT NOT NULL,
    price_list_version INTEGER NOT NULL
);
CREATE INDEX menu_prices_product_id_idx ON menu_prices (product_id, order_type);
CREATE INDEX menu_prices_variant_id_idx ON menu_prices (variant_id, order_type);
