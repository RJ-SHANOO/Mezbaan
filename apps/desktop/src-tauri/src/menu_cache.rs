//! P2-11: the terminal's local menu cache — ingests the `menu` section of
//! P1-27's signed snapshot (snapshot_sync.rs verifies it first) and serves
//! the category grid / search / barcode lookup the POS screen needs, with no
//! network call in that path (rule: "no network call in the sale path").
//!
//! Default order type ("dine_in") is a deliberate simplification: this
//! screen has no order-type selector yet, so product queries always resolve
//! a price for that one order type. Real order-type-aware pricing is a
//! cart-time concern (P2-12 onward), not this cache's job.
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fmt;

const DEFAULT_ORDER_TYPE: &str = "dine_in";

#[derive(Debug)]
pub enum MenuCacheError {
    Db(rusqlite::Error),
    Parse(String),
}

impl fmt::Display for MenuCacheError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MenuCacheError::Db(e) => write!(f, "menu cache storage error: {e}"),
            MenuCacheError::Parse(detail) => write!(f, "menu cache: couldn't parse snapshot content: {detail}"),
        }
    }
}

impl std::error::Error for MenuCacheError {}

impl From<rusqlite::Error> for MenuCacheError {
    fn from(e: rusqlite::Error) -> Self {
        MenuCacheError::Db(e)
    }
}

#[derive(Deserialize)]
struct SnapshotMenuCategory {
    id: String,
    name: String,
    #[serde(rename = "sortOrder")]
    sort_order: i64,
}

#[derive(Deserialize)]
struct SnapshotMenuProduct {
    id: String,
    #[serde(rename = "categoryId")]
    category_id: String,
    name: String,
    sku: Option<String>,
    barcode: Option<String>,
    #[serde(rename = "imageUrl")]
    image_url: Option<String>,
    #[serde(rename = "sortOrder")]
    sort_order: i64,
}

#[derive(Deserialize)]
struct SnapshotMenuVariant {
    id: String,
    #[serde(rename = "productId")]
    product_id: String,
    name: String,
    sku: Option<String>,
    barcode: Option<String>,
    #[serde(rename = "sortOrder")]
    sort_order: i64,
}

#[derive(Deserialize)]
struct SnapshotMenuPrice {
    #[serde(rename = "productId")]
    product_id: Option<String>,
    #[serde(rename = "variantId")]
    variant_id: Option<String>,
    #[serde(rename = "orderType")]
    order_type: String,
    #[serde(rename = "unitPriceMinor")]
    unit_price_minor: String,
    currency: String,
    #[serde(rename = "priceListId")]
    price_list_id: String,
    #[serde(rename = "priceListVersion")]
    price_list_version: i64,
}

#[derive(Deserialize)]
struct SnapshotMenu {
    categories: Vec<SnapshotMenuCategory>,
    products: Vec<SnapshotMenuProduct>,
    variants: Vec<SnapshotMenuVariant>,
    prices: Vec<SnapshotMenuPrice>,
}

#[derive(Deserialize)]
struct SnapshotContent {
    menu: SnapshotMenu,
}

/// Wholesale replace (rule 11: for menu/settings data, the server's version
/// wins) — never a merge, same as manager_pin_offline::ingest_snapshot.
pub fn ingest_snapshot(conn: &mut Connection, content_json: &str) -> Result<usize, MenuCacheError> {
    let content: SnapshotContent = serde_json::from_str(content_json).map_err(|e| MenuCacheError::Parse(e.to_string()))?;
    let menu = content.menu;

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM menu_prices", [])?;
    tx.execute("DELETE FROM menu_variants", [])?;
    tx.execute("DELETE FROM menu_products", [])?;
    tx.execute("DELETE FROM menu_categories", [])?;

    for category in &menu.categories {
        tx.execute(
            "INSERT INTO menu_categories (id, name, sort_order) VALUES (?1, ?2, ?3)",
            (&category.id, &category.name, category.sort_order),
        )?;
    }
    for product in &menu.products {
        tx.execute(
            "INSERT INTO menu_products (id, category_id, name, sku, barcode, image_url, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (&product.id, &product.category_id, &product.name, &product.sku, &product.barcode, &product.image_url, product.sort_order),
        )?;
    }
    for variant in &menu.variants {
        tx.execute(
            "INSERT INTO menu_variants (id, product_id, name, sku, barcode, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (&variant.id, &variant.product_id, &variant.name, &variant.sku, &variant.barcode, variant.sort_order),
        )?;
    }
    for price in &menu.prices {
        tx.execute(
            "INSERT INTO menu_prices (product_id, variant_id, order_type, unit_price_minor, currency, price_list_id, price_list_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (&price.product_id, &price.variant_id, &price.order_type, &price.unit_price_minor, &price.currency, &price.price_list_id, price.price_list_version),
        )?;
    }

    let count = menu.categories.len() + menu.products.len();
    tx.commit()?;
    Ok(count)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MenuCategory {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MenuProduct {
    pub id: String,
    pub category_id: String,
    pub name: String,
    pub sku: Option<String>,
    pub barcode: Option<String>,
    pub image_url: Option<String>,
    pub sort_order: i64,
    /// The default order type's resolved price, if one has been synced — see
    /// DEFAULT_ORDER_TYPE. `None` means nothing's been priced for this
    /// product yet, not an error.
    pub unit_price_minor: Option<String>,
    pub currency: Option<String>,
}

pub fn list_categories(conn: &Connection) -> rusqlite::Result<Vec<MenuCategory>> {
    let mut stmt = conn.prepare("SELECT id, name, sort_order FROM menu_categories ORDER BY sort_order, name")?;
    let rows = stmt.query_map([], |row| {
        Ok(MenuCategory { id: row.get(0)?, name: row.get(1)?, sort_order: row.get(2)? })
    })?;
    rows.collect()
}

/// `category_id` filters to one category; `search` matches name/sku/barcode
/// as a case-insensitive substring. Either or both may be omitted.
pub fn list_products(conn: &Connection, category_id: Option<&str>, search: Option<&str>) -> rusqlite::Result<Vec<MenuProduct>> {
    let search_pattern = search.map(|s| format!("%{}%", s.to_lowercase()));
    let mut stmt = conn.prepare(
        "SELECT p.id, p.category_id, p.name, p.sku, p.barcode, p.image_url, p.sort_order, pr.unit_price_minor, pr.currency
         FROM menu_products p
         LEFT JOIN menu_prices pr ON pr.product_id = p.id AND pr.order_type = ?1
         WHERE (?2 IS NULL OR p.category_id = ?2)
           AND (?3 IS NULL OR lower(p.name) LIKE ?3 OR lower(p.sku) LIKE ?3 OR lower(p.barcode) LIKE ?3)
         ORDER BY p.sort_order, p.name",
    )?;
    let rows = stmt.query_map((DEFAULT_ORDER_TYPE, category_id, &search_pattern), map_product_row)?;
    rows.collect()
}

/// Exact match, for a barcode scanner's input — never a substring search,
/// unlike the free-text `search` field above.
pub fn find_by_barcode(conn: &Connection, barcode: &str) -> rusqlite::Result<Option<MenuProduct>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.category_id, p.name, p.sku, p.barcode, p.image_url, p.sort_order, pr.unit_price_minor, pr.currency
         FROM menu_products p
         LEFT JOIN menu_prices pr ON pr.product_id = p.id AND pr.order_type = ?1
         WHERE p.barcode = ?2
         LIMIT 1",
    )?;
    stmt.query_row((DEFAULT_ORDER_TYPE, barcode), map_product_row).optional()
}

fn map_product_row(row: &rusqlite::Row) -> rusqlite::Result<MenuProduct> {
    Ok(MenuProduct {
        id: row.get(0)?,
        category_id: row.get(1)?,
        name: row.get(2)?,
        sku: row.get(3)?,
        barcode: row.get(4)?,
        image_url: row.get(5)?,
        sort_order: row.get(6)?,
        unit_price_minor: row.get(7)?,
        currency: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0005_menu_cache.sql")).unwrap();
        conn
    }

    fn sample_content() -> String {
        r#"{
            "menu": {
                "categories": [{"id": "cat-1", "name": "Burgers", "sortOrder": 0}],
                "products": [
                    {"id": "prod-1", "categoryId": "cat-1", "name": "Cheeseburger", "sku": "CB-1", "barcode": "1111", "imageUrl": null, "sortOrder": 0},
                    {"id": "prod-2", "categoryId": "cat-1", "name": "Veggie Burger", "sku": null, "barcode": "2222", "imageUrl": null, "sortOrder": 1}
                ],
                "variants": [{"id": "var-1", "productId": "prod-1", "name": "Large", "sku": null, "barcode": null, "sortOrder": 0}],
                "prices": [
                    {"productId": "prod-1", "orderType": "dine_in", "unitPriceMinor": "1500", "currency": "PKR", "priceListId": "pl-1", "priceListVersion": 1},
                    {"productId": "prod-1", "orderType": "takeaway", "unitPriceMinor": "1400", "currency": "PKR", "priceListId": "pl-1", "priceListVersion": 1}
                ]
            }
        }"#
        .to_string()
    }

    #[test]
    fn ingests_categories_products_variants_and_prices() {
        let mut conn = test_conn();
        let count = ingest_snapshot(&mut conn, &sample_content()).unwrap();
        assert_eq!(count, 3); // 1 category + 2 products

        let categories = list_categories(&conn).unwrap();
        assert_eq!(categories, vec![MenuCategory { id: "cat-1".into(), name: "Burgers".into(), sort_order: 0 }]);

        let products = list_products(&conn, None, None).unwrap();
        assert_eq!(products.len(), 2);
        let cheeseburger = products.iter().find(|p| p.id == "prod-1").unwrap();
        assert_eq!(cheeseburger.unit_price_minor, Some("1500".to_string())); // dine_in default, not the takeaway price
    }

    #[test]
    fn a_second_ingest_wholesale_replaces_the_first_rather_than_merging() {
        let mut conn = test_conn();
        ingest_snapshot(&mut conn, &sample_content()).unwrap();

        let empty = r#"{"menu": {"categories": [], "products": [], "variants": [], "prices": []}}"#;
        ingest_snapshot(&mut conn, empty).unwrap();

        assert_eq!(list_categories(&conn).unwrap(), vec![]);
        assert_eq!(list_products(&conn, None, None).unwrap(), vec![]);
    }

    #[test]
    fn filters_products_by_category_and_by_search_text() {
        let mut conn = test_conn();
        ingest_snapshot(&mut conn, &sample_content()).unwrap();

        let by_category = list_products(&conn, Some("cat-1"), None).unwrap();
        assert_eq!(by_category.len(), 2);
        let other_category = list_products(&conn, Some("cat-nonexistent"), None).unwrap();
        assert_eq!(other_category, vec![]);

        let by_name = list_products(&conn, None, Some("veggie")).unwrap();
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].id, "prod-2");

        let by_sku = list_products(&conn, None, Some("cb-1")).unwrap();
        assert_eq!(by_sku.len(), 1);
        assert_eq!(by_sku[0].id, "prod-1");
    }

    #[test]
    fn finds_a_product_by_its_exact_barcode_but_not_a_partial_one() {
        let mut conn = test_conn();
        ingest_snapshot(&mut conn, &sample_content()).unwrap();

        let found = find_by_barcode(&conn, "2222").unwrap();
        assert_eq!(found.map(|p| p.id), Some("prod-2".to_string()));

        let not_found = find_by_barcode(&conn, "222").unwrap();
        assert_eq!(not_found, None);
    }

    #[test]
    fn a_product_with_no_synced_price_has_a_null_price_not_an_error() {
        let mut conn = test_conn();
        let content = r#"{
            "menu": {
                "categories": [{"id": "cat-1", "name": "Burgers", "sortOrder": 0}],
                "products": [{"id": "prod-1", "categoryId": "cat-1", "name": "Cheeseburger", "sku": null, "barcode": null, "imageUrl": null, "sortOrder": 0}],
                "variants": [],
                "prices": []
            }
        }"#;
        ingest_snapshot(&mut conn, content).unwrap();

        let products = list_products(&conn, None, None).unwrap();
        assert_eq!(products[0].unit_price_minor, None);
    }
}
