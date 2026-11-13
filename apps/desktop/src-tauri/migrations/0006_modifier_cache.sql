-- P2-12: the terminal's local cache of modifier groups/options and which
-- products they're attached to — same wholesale-replace-on-sync convention
-- as 0005_menu_cache.sql. menu_prices gains a modifier_option_id column so
-- an option's own resolved price can live in the same table as product and
-- variant prices (exactly one of the three is ever set per row, mirroring
-- the server's price_list_items convention).
ALTER TABLE menu_prices ADD COLUMN modifier_option_id TEXT;
CREATE INDEX menu_prices_modifier_option_id_idx ON menu_prices (modifier_option_id, order_type);

CREATE TABLE modifier_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    min_selections INTEGER NOT NULL,
    max_selections INTEGER,
    sort_order INTEGER NOT NULL
);

CREATE TABLE modifier_options (
    id TEXT PRIMARY KEY,
    modifier_group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL
);
CREATE INDEX modifier_options_group_id_idx ON modifier_options (modifier_group_id);

CREATE TABLE product_modifier_groups (
    product_id TEXT NOT NULL,
    modifier_group_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (product_id, modifier_group_id)
);
CREATE INDEX product_modifier_groups_product_id_idx ON product_modifier_groups (product_id);
