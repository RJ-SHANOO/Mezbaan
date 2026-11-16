//! P2-33: renders a receipt's ESC/POS bytes from the current settings and
//! one invoice's content. Pure — returns bytes for the frontend to hand to
//! P2-32's `enqueue_print_job`, rather than printing directly itself.
use crate::receipt_template::{self, ReceiptContent, ReceiptSettings};

#[tauri::command]
pub fn render_receipt(settings: ReceiptSettings, content: ReceiptContent) -> Vec<u8> {
    receipt_template::render(&settings, &content)
}
