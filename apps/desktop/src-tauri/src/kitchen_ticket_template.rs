//! P3-04: turns one kitchen ticket (from KitchenTicketsTerminalController,
//! via kitchen-ticket-client.ts) into real ESC/POS bytes. Pure and I/O-free
//! — the result is handed to P2-32's print queue (`enqueue_print_job`), not
//! sent directly from here. No money field is ever accepted by this struct
//! at all (rule 18) — there is nothing here to accidentally print.
use crate::escpos::{Align, ReceiptBuilder};
use serde::Deserialize;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KitchenTicketModifier {
    pub name: String,
    pub quantity: i64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KitchenTicketItem {
    pub name: String,
    pub quantity: i64,
    pub notes: Option<String>,
    pub seat_number: Option<i64>,
    pub course: Option<String>,
    pub modifiers: Vec<KitchenTicketModifier>,
    pub voided: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KitchenTicketContent {
    /// A short, human-readable order reference (e.g. the first 8 chars of
    /// the order id) — not the full UUID, which is too long for a narrow
    /// receipt-width line.
    pub order_short_id: String,
    pub station_name: Option<String>,
    pub rush: bool,
    /// Already formatted for display by the caller (e.g. a local time
    /// string) — this module does no date/timezone handling of its own.
    pub fired_at_label: String,
    pub items: Vec<KitchenTicketItem>,
}

pub fn render(content: &KitchenTicketContent) -> Vec<u8> {
    let mut builder = ReceiptBuilder::new().align(Align::Center).bold(true).line(&format!("ORDER #{}", content.order_short_id));

    if let Some(station) = &content.station_name {
        builder = builder.line(station);
    }
    if content.rush {
        builder = builder.line("*** RUSH ***");
    }

    builder = builder.bold(false).line(&content.fired_at_label).align(Align::Left);

    for item in &content.items {
        let marker = if item.voided { "VOID " } else { "" };
        builder = builder.line(&format!("{marker}{}x {}", item.quantity, item.name));
        for modifier in &item.modifiers {
            builder = builder.line(&format!("  {}x {}", modifier.quantity, modifier.name));
        }
        if let Some(notes) = &item.notes {
            builder = builder.line(&format!("  Note: {notes}"));
        }
        let seat = item.seat_number.map(|s| format!("Seat {s}"));
        let course = item.course.clone();
        let seat_course = [seat, course].into_iter().flatten().collect::<Vec<_>>().join(" - ");
        if !seat_course.is_empty() {
            builder = builder.line(&format!("  {seat_course}"));
        }
    }

    builder.feed(3).cut().build()
}
