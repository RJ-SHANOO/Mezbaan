//! P2-45: the glue between charges.rs's pure arithmetic and the menu cache's
//! already-synced tax config — the frontend's one entry point for pricing an
//! offline sale with no network call, same "resolve once, sync the result,
//! price locally" shape menu_commands.rs already uses for products/modifiers.
use crate::charges::{self, ChargesConfig, PricingMode, RoundingMode};
use crate::db::DbState;
use crate::menu_cache;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChargesResultWire {
    pub subtotal: String,
    pub service_charge: String,
    pub tax_base: String,
    pub tax: String,
    pub total: String,
}

/// Errors if this order type's tax config was never synced (a fresh terminal
/// that hasn't pulled a snapshot yet) rather than silently assuming 0% tax —
/// under-reporting tax on a real sale would violate rule 6, so this fails
/// loudly and asks the caller to sync first instead of guessing.
#[tauri::command]
pub fn compute_offline_charges(db_state: State<DbState>, order_type: String, subtotal_minor: String) -> Result<ChargesResultWire, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;

    let tax_config = menu_cache::get_tax_config(conn, &order_type)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no synced tax config for order type \"{order_type}\" — sync the menu first"))?;

    let subtotal: i128 = subtotal_minor.parse().map_err(|_| format!("invalid subtotal amount: \"{subtotal_minor}\""))?;

    let pricing_mode = match tax_config.pricing_mode.as_str() {
        "inclusive" => PricingMode::Inclusive,
        "exclusive" => PricingMode::Exclusive,
        other => return Err(format!("unknown pricing mode: \"{other}\"")),
    };

    let config = ChargesConfig {
        pricing_mode,
        tax_rate_basis_points: tax_config.tax_rate_basis_points,
        service_charge_rate_basis_points: tax_config.service_charge_rate_basis_points,
        service_charge_is_taxable: tax_config.service_charge_is_taxable,
    };

    let result = charges::compute_charges(subtotal, &config, RoundingMode::HalfUp).map_err(|e| e.to_string())?;

    Ok(ChargesResultWire {
        subtotal: result.subtotal.to_string(),
        service_charge: result.service_charge.to_string(),
        tax_base: result.tax_base.to_string(),
        tax: result.tax.to_string(),
        total: result.total.to_string(),
    })
}
