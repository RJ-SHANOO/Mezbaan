-- P2-41: composite indexes for the POS screen's actual query shapes.
-- Each replaces an existing single-column index with one that ALSO covers
-- the query's own ORDER BY, so SQLite can serve "filter + already in sort
-- order" from the index directly instead of filtering then sorting
-- separately — the category/modifier-group browsing paths (tapping a
-- tile), which happen far more often per order than typing a free-text
-- search.
--
-- Deliberately NOT touched here: the free-text name/sku/barcode substring
-- search in menu_cache.rs's list_products (`lower(name) LIKE '%term%'`).
-- A leading-wildcard LIKE can never use a plain b-tree index in SQLite,
-- with or without an index on the column — that's a property of the
-- query shape, not a missing index. The correct tool for real
-- index-accelerated substring search is an FTS5 virtual table with the
-- trigram tokenizer, but this crate's bundled SQLite build hasn't been
-- confirmed (no cargo build this session) to have the trigram tokenizer
-- compiled in, and guessing wrong would silently break menu sync. Left
-- undone rather than risking that — see menu_cache.rs's own comment on
-- list_products for the full reasoning.
-- At a single branch's realistic menu size (tens to a few hundred items),
-- the existing full-scan search is not expected to be a measurable
-- bottleneck — rule 9: "measure before optimizing."

DROP INDEX IF EXISTS menu_products_category_id_idx;
CREATE INDEX menu_products_category_sort_idx ON menu_products (category_id, sort_order, name);

CREATE INDEX menu_categories_sort_idx ON menu_categories (sort_order, name);

DROP INDEX IF EXISTS product_modifier_groups_product_id_idx;
CREATE INDEX product_modifier_groups_product_sort_idx ON product_modifier_groups (product_id, sort_order);

DROP INDEX IF EXISTS modifier_options_group_id_idx;
CREATE INDEX modifier_options_group_sort_idx ON modifier_options (modifier_group_id, sort_order);
