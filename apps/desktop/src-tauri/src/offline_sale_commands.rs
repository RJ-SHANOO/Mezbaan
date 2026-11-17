//! P2-45: the frontend's one entry point for completing a sale entirely
//! from local data — the checkout button's call, with no network call
//! anywhere in this path.
use crate::db::DbState;
use crate::offline_sales::{self, CartLineInput, OfflineInvoice};
use tauri::State;

#[tauri::command]
pub fn complete_offline_sale(db_state: State<DbState>, order_type: String, currency: String, lines: Vec<CartLineInput>, idempotency_key: String) -> Result<OfflineInvoice, String> {
    let mut guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or_else(|| "local database unavailable".to_string())?;
    offline_sales::complete_sale(conn, &order_type, &currency, &lines, &idempotency_key).map_err(|e| e.to_string())
}
