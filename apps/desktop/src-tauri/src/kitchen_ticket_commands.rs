//! P3-04: renders a kitchen ticket's ESC/POS bytes. Pure — returns bytes for
//! the frontend to hand to P2-32's `enqueue_print_job`, rather than printing
//! directly itself, same shape as receipt_commands.rs.
use crate::kitchen_ticket_template::{self, KitchenTicketContent};

#[tauri::command]
pub fn render_kitchen_ticket(content: KitchenTicketContent) -> Vec<u8> {
    kitchen_ticket_template::render(&content)
}
