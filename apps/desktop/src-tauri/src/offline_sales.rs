//! P2-45: completes a sale entirely from local data — prices the cart via
//! charges.rs (fed by menu_cache.rs's synced tax config), mints a P1-28
//! document number from device_identity.rs's own branch/terminal number,
//! and records both the invoice and its operation_log row in the one local
//! transaction rule 8 requires. The first real caller of operation_log's
//! `record_once` (P1-24's own docs note it had none yet) and of
//! document_number's series (P1-28's own docs note the same).
//!
//! Deliberately validates its preconditions (tax config synced, this
//! terminal paired) *before* opening the write transaction — they're reads
//! needed to construct what gets written, not part of the atomic write
//! itself, and `record_once`'s closure only ever gets a `&Transaction`
//! (never a `&mut Connection`), so anything needing its own nested
//! transaction — document_number::next_document_number included — has to
//! be inlined here against `tx` directly rather than called as a function.
use crate::charges::{self, ChargesConfig, PricingMode, RoundingMode};
use crate::device_identity::{self, DeviceIdentity};
use crate::menu_cache::{self, TaxConfig};
use crate::operation_log::{self, NewOperation, RecordOutcome};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug)]
pub enum OfflineSaleError {
    Db(rusqlite::Error),
    NotPaired,
    TaxConfigNotSynced(String),
    UnknownPricingMode(String),
    InvalidAmount(String),
    CurrencyMismatch { expected: String, found: String },
}

impl fmt::Display for OfflineSaleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OfflineSaleError::Db(e) => write!(f, "offline sale storage error: {e}"),
            OfflineSaleError::NotPaired => write!(f, "this terminal has no stored branch/terminal number — pair it again"),
            OfflineSaleError::TaxConfigNotSynced(order_type) => write!(f, "no synced tax config for order type \"{order_type}\" — sync the menu first"),
            OfflineSaleError::UnknownPricingMode(mode) => write!(f, "unknown pricing mode: \"{mode}\""),
            OfflineSaleError::InvalidAmount(amount) => write!(f, "invalid amount: \"{amount}\""),
            OfflineSaleError::CurrencyMismatch { expected, found } => write!(f, "currency mismatch: expected {expected}, found {found}"),
        }
    }
}

impl std::error::Error for OfflineSaleError {}

impl From<rusqlite::Error> for OfflineSaleError {
    fn from(e: rusqlite::Error) -> Self {
        OfflineSaleError::Db(e)
    }
}

impl From<charges::ChargesError> for OfflineSaleError {
    fn from(e: charges::ChargesError) -> Self {
        OfflineSaleError::InvalidAmount(e.to_string())
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CartLineModifierInput {
    pub modifier_option_id: String,
    pub name: String,
    pub unit_price_minor: String,
    pub currency: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CartLineInput {
    pub product_id: String,
    pub name: String,
    pub quantity: i64,
    pub unit_price_minor: String,
    pub currency: String,
    #[serde(default)]
    pub modifiers: Vec<CartLineModifierInput>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineInvoice {
    pub id: String,
    pub document_number: String,
    pub order_type: String,
    pub currency: String,
    pub subtotal_minor: String,
    pub service_charge_minor: String,
    pub tax_base_minor: String,
    pub tax_minor: String,
    pub total_minor: String,
}

fn parse_minor(amount_minor: &str) -> Result<i128, OfflineSaleError> {
    amount_minor.parse::<i128>().map_err(|_| OfflineSaleError::InvalidAmount(amount_minor.to_string()))
}

/// Mirrors cart.ts's lineTotal/cartTotal exactly: a line's per-unit amount is
/// its own price plus every modifier's price, multiplied by quantity; the
/// subtotal is the sum across lines. Also enforces every line/modifier
/// shares `currency` — cart.ts gets this for free from Money's own
/// assertSameCurrency inside add()/sum(), so this mirrors that guarantee
/// rather than silently summing mismatched currencies.
fn compute_subtotal(currency: &str, lines: &[CartLineInput]) -> Result<i128, OfflineSaleError> {
    let mut total: i128 = 0;
    for line in lines {
        if line.currency != currency {
            return Err(OfflineSaleError::CurrencyMismatch { expected: currency.to_string(), found: line.currency.clone() });
        }
        let mut per_unit = parse_minor(&line.unit_price_minor)?;
        for modifier in &line.modifiers {
            if modifier.currency != currency {
                return Err(OfflineSaleError::CurrencyMismatch { expected: currency.to_string(), found: modifier.currency.clone() });
            }
            per_unit += parse_minor(&modifier.unit_price_minor)?;
        }
        total += per_unit * line.quantity as i128;
    }
    Ok(total)
}

fn parse_pricing_mode(raw: &str) -> Result<PricingMode, OfflineSaleError> {
    match raw {
        "inclusive" => Ok(PricingMode::Inclusive),
        "exclusive" => Ok(PricingMode::Exclusive),
        other => Err(OfflineSaleError::UnknownPricingMode(other.to_string())),
    }
}

fn to_charges_config(tax_config: &TaxConfig) -> Result<ChargesConfig, OfflineSaleError> {
    Ok(ChargesConfig {
        pricing_mode: parse_pricing_mode(&tax_config.pricing_mode)?,
        tax_rate_basis_points: tax_config.tax_rate_basis_points,
        service_charge_rate_basis_points: tax_config.service_charge_rate_basis_points,
        service_charge_is_taxable: tax_config.service_charge_is_taxable,
    })
}

/// Already-created invoice for an idempotency key seen before — the retry
/// path still needs to hand the caller back the real document number, not
/// just "ok, nothing happened".
fn load_invoice_by_idempotency_key(conn: &Connection, idempotency_key: &str) -> Result<Option<OfflineInvoice>, OfflineSaleError> {
    conn.query_row(
        "SELECT id, document_number, order_type, currency, subtotal_minor, service_charge_minor, tax_base_minor, tax_minor, total_minor
         FROM offline_invoices WHERE idempotency_key = ?1",
        [idempotency_key],
        |row| {
            Ok(OfflineInvoice {
                id: row.get(0)?,
                document_number: row.get(1)?,
                order_type: row.get(2)?,
                currency: row.get(3)?,
                subtotal_minor: row.get(4)?,
                service_charge_minor: row.get(5)?,
                tax_base_minor: row.get(6)?,
                tax_minor: row.get(7)?,
                total_minor: row.get(8)?,
            })
        },
    )
    .optional()
    .map_err(OfflineSaleError::from)
}

/// Prices `lines` for `order_type` and records a new invoice, with no
/// network call anywhere in this path. Rejects (never guesses) when this
/// terminal has no stored identity or `order_type`'s tax config was never
/// synced — silently assuming 0% tax or an unpaired device's identity would
/// risk under-reporting a real sale (rule 6). Retrying the same
/// `idempotency_key` returns the invoice already created under it rather
/// than creating a second one or erroring (rule 9).
pub fn complete_sale(conn: &mut Connection, order_type: &str, currency: &str, lines: &[CartLineInput], idempotency_key: &str) -> Result<OfflineInvoice, OfflineSaleError> {
    if let Some(existing) = load_invoice_by_idempotency_key(conn, idempotency_key)? {
        return Ok(existing);
    }

    // device_identity::load's own error type doesn't convert via `?` here (it
    // deliberately doesn't expose its inner rusqlite::Error) — a read failure
    // is rare enough that collapsing it into the same "not paired, pair
    // again" message is a reasonable, actionable simplification.
    let identity: DeviceIdentity = device_identity::load(conn).map_err(|_| OfflineSaleError::NotPaired)?.ok_or(OfflineSaleError::NotPaired)?;
    let tax_config = menu_cache::get_tax_config(conn, order_type)?.ok_or_else(|| OfflineSaleError::TaxConfigNotSynced(order_type.to_string()))?;
    let charges_config = to_charges_config(&tax_config)?;

    let subtotal = compute_subtotal(currency, lines)?;
    let result = charges::compute_charges(subtotal, &charges_config, RoundingMode::HalfUp)?;

    let operation_id = operation_log::new_operation_id();
    let payload = serde_json::to_string(&(order_type, currency, lines)).expect("sale payload always serializes");
    let operation = NewOperation { id: operation_id.clone(), idempotency_key: idempotency_key.to_string(), operation_type: "offline_sale.completed".to_string(), payload };

    let outcome = operation_log::record_once::<OfflineInvoice, OfflineSaleError, _>(conn, operation, |tx| {
        // Inlined document_number::next_document_number — that function
        // opens its own transaction, which isn't available from in here
        // (see this module's own docs for why).
        let sequence: i64 = tx.query_row("SELECT next_number FROM document_number_sequence WHERE id = 1", [], |row| row.get(0))?;
        tx.execute("UPDATE document_number_sequence SET next_number = next_number + 1 WHERE id = 1", [])?;
        let document_number = format!("B{}-T{}-{:06}", identity.branch_number, identity.terminal_number, sequence);

        let invoice = OfflineInvoice {
            id: operation_id.clone(),
            document_number,
            order_type: order_type.to_string(),
            currency: currency.to_string(),
            subtotal_minor: result.subtotal.to_string(),
            service_charge_minor: result.service_charge.to_string(),
            tax_base_minor: result.tax_base.to_string(),
            tax_minor: result.tax.to_string(),
            total_minor: result.total.to_string(),
        };

        tx.execute(
            "INSERT INTO offline_invoices (id, idempotency_key, document_number, order_type, currency, subtotal_minor, service_charge_minor, tax_base_minor, tax_minor, total_minor, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            (
                &invoice.id,
                idempotency_key,
                &invoice.document_number,
                &invoice.order_type,
                &invoice.currency,
                &invoice.subtotal_minor,
                &invoice.service_charge_minor,
                &invoice.tax_base_minor,
                &invoice.tax_minor,
                &invoice.total_minor,
            ),
        )?;

        for line in lines {
            tx.execute(
                "INSERT INTO offline_invoice_items (invoice_id, product_id, name, quantity, unit_price_minor, currency) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                (&invoice.id, &line.product_id, &line.name, line.quantity, &line.unit_price_minor, &line.currency),
            )?;
            let item_id = tx.last_insert_rowid();
            for modifier in &line.modifiers {
                tx.execute(
                    "INSERT INTO offline_invoice_item_modifiers (item_id, modifier_option_id, name, unit_price_minor, currency) VALUES (?1, ?2, ?3, ?4, ?5)",
                    (item_id, &modifier.modifier_option_id, &modifier.name, &modifier.unit_price_minor, &modifier.currency),
                )?;
            }
        }

        Ok(invoice)
    })?;

    match outcome {
        RecordOutcome::Recorded(invoice) => Ok(invoice),
        // A concurrent/overlapping retry raced us between the lookup above and
        // record_once's own idempotency check — the row is there now either way.
        RecordOutcome::AlreadyRecorded => load_invoice_by_idempotency_key(conn, idempotency_key)?.ok_or(OfflineSaleError::NotPaired),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/0002_operation_log.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/0004_document_number_sequence.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/0005_menu_cache.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/0006_modifier_cache.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/0011_tax_config_cache.sql")).unwrap();
        conn.execute_batch(include_str!("../migrations/0012_offline_sales.sql")).unwrap();
        conn
    }

    fn paired(conn: &Connection) {
        device_identity::save(conn, DeviceIdentity { branch_number: 1, terminal_number: 2 }).unwrap();
    }

    fn synced_tax_config(conn: &Connection, order_type: &str, tax_rate_basis_points: i64, service_charge_rate_basis_points: Option<i64>, service_charge_is_taxable: Option<bool>) {
        conn.execute(
            "INSERT INTO tax_config (order_type, pricing_mode, tax_rate_basis_points, service_charge_rate_basis_points, service_charge_is_taxable) VALUES (?1, 'exclusive', ?2, ?3, ?4)",
            (order_type, tax_rate_basis_points, service_charge_rate_basis_points, service_charge_is_taxable),
        )
        .unwrap();
    }

    fn line(unit_price_minor: &str, quantity: i64) -> CartLineInput {
        CartLineInput { product_id: "prod-1".into(), name: "Cheeseburger".into(), quantity, unit_price_minor: unit_price_minor.into(), currency: "PKR".into(), modifiers: vec![] }
    }

    #[test]
    fn completes_a_sale_and_persists_the_invoice_and_its_items() {
        let mut conn = test_conn();
        paired(&conn);
        synced_tax_config(&conn, "dine_in", 1000, None, None);

        let lines = vec![line("1500", 2)]; // 3000 subtotal @ 10% tax
        let invoice = complete_sale(&mut conn, "dine_in", "PKR", &lines, "idem-1").unwrap();

        assert_eq!(invoice.document_number, "B1-T2-000001");
        assert_eq!(invoice.subtotal_minor, "3000");
        assert_eq!(invoice.tax_minor, "300");
        assert_eq!(invoice.total_minor, "3300");

        let item_count: i64 = conn.query_row("SELECT count(*) FROM offline_invoice_items WHERE invoice_id = ?1", [&invoice.id], |r| r.get(0)).unwrap();
        assert_eq!(item_count, 1);
    }

    #[test]
    fn a_modifier_adds_to_the_per_unit_price_before_multiplying_by_quantity() {
        let mut conn = test_conn();
        paired(&conn);
        synced_tax_config(&conn, "dine_in", 0, None, None);

        let mut with_modifier = line("1000", 3);
        with_modifier.modifiers = vec![CartLineModifierInput { modifier_option_id: "mod-1".into(), name: "Extra Cheese".into(), unit_price_minor: "100".into(), currency: "PKR".into() }];

        let invoice = complete_sale(&mut conn, "dine_in", "PKR", &[with_modifier], "idem-2").unwrap();
        assert_eq!(invoice.subtotal_minor, "3300"); // (1000 + 100) * 3

        let modifier_count: i64 = conn.query_row("SELECT count(*) FROM offline_invoice_item_modifiers", [], |r| r.get(0)).unwrap();
        assert_eq!(modifier_count, 1);
    }

    #[test]
    fn rejects_an_unpaired_terminal_rather_than_guessing_a_document_number() {
        let mut conn = test_conn();
        synced_tax_config(&conn, "dine_in", 1000, None, None);

        let result = complete_sale(&mut conn, "dine_in", "PKR", &[line("1500", 1)], "idem-3");
        assert!(matches!(result, Err(OfflineSaleError::NotPaired)));
    }

    #[test]
    fn rejects_an_order_type_whose_tax_config_was_never_synced_rather_than_assuming_zero_tax() {
        let mut conn = test_conn();
        paired(&conn);

        let result = complete_sale(&mut conn, "delivery", "PKR", &[line("1500", 1)], "idem-4");
        assert!(matches!(result, Err(OfflineSaleError::TaxConfigNotSynced(order_type)) if order_type == "delivery"));
    }

    #[test]
    fn retrying_the_same_idempotency_key_returns_the_original_invoice_rather_than_creating_a_second_one() {
        let mut conn = test_conn();
        paired(&conn);
        synced_tax_config(&conn, "dine_in", 1000, None, None);

        let first = complete_sale(&mut conn, "dine_in", "PKR", &[line("1500", 1)], "idem-5").unwrap();
        let second = complete_sale(&mut conn, "dine_in", "PKR", &[line("9999", 7)], "idem-5").unwrap(); // deliberately different lines

        assert_eq!(first, second);

        let invoice_count: i64 = conn.query_row("SELECT count(*) FROM offline_invoices", [], |r| r.get(0)).unwrap();
        assert_eq!(invoice_count, 1);
    }

    #[test]
    fn two_sales_in_a_row_get_strictly_increasing_document_numbers() {
        let mut conn = test_conn();
        paired(&conn);
        synced_tax_config(&conn, "dine_in", 0, None, None);

        let first = complete_sale(&mut conn, "dine_in", "PKR", &[line("1000", 1)], "idem-6").unwrap();
        let second = complete_sale(&mut conn, "dine_in", "PKR", &[line("1000", 1)], "idem-7").unwrap();

        assert_eq!(first.document_number, "B1-T2-000001");
        assert_eq!(second.document_number, "B1-T2-000002");
    }

    #[test]
    fn service_charge_rate_is_honored_from_the_synced_tax_config() {
        let mut conn = test_conn();
        paired(&conn);
        synced_tax_config(&conn, "dine_in", 0, Some(1000), Some(false)); // 10% service charge, not taxable

        let invoice = complete_sale(&mut conn, "dine_in", "PKR", &[line("10000", 1)], "idem-8").unwrap();
        assert_eq!(invoice.service_charge_minor, "1000");
        assert_eq!(invoice.total_minor, "11000");
    }
}
