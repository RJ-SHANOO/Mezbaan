//! P2-31/P2-32: the frontend's entry points for sending ESC/POS bytes to a
//! real printer, either directly (`print_raw_escpos`, no retry — P2-31) or
//! through the persistent, retrying queue (P2-32). No caller exists yet —
//! P2-33's receipt templates are what will actually build real receipt
//! bytes for a real sale; these commands are the primitives they'll sit on
//! top of, same "backend/transport layer first, wiring follows" scoping as
//! P2-11/P2-12's menu cache.
use crate::db::DbState;
use crate::escpos::{Align, DrawerPin, ReceiptBuilder};
use crate::print_queue::{self, PrintJobRecord, QueueStatusSummary};
use crate::printer_discovery::{self, UsbDeviceCandidate};
use crate::printer_transport::PrinterConnectionConfig;
use serde::Serialize;
use tauri::State;

/// P2-35: USB devices currently plugged in, for the printer setup screen's
/// picker — see printer_discovery.rs for why this lists every USB device
/// rather than trying to filter to "printers only."
#[tauri::command]
pub fn list_usb_printer_candidates() -> Result<Vec<UsbDeviceCandidate>, String> {
    printer_discovery::list_usb_devices()
}

/// P2-35: a human-readable test page — the setup screen's "Test Print"
/// button. Sent directly (same reasoning as kick_cash_drawer: an
/// interactive "click it, see the result now" action, not something to
/// queue and retry minutes later).
#[tauri::command]
pub fn print_test_page(connection: PrinterConnectionConfig) -> Result<(), String> {
    let bytes = ReceiptBuilder::new()
        .align(Align::Center)
        .bold(true)
        .line("MEZBAAN")
        .bold(false)
        .line("Printer Test Page")
        .align(Align::Left)
        .line("If you can read this, the printer")
        .line("is connected and working correctly.")
        .feed(3)
        .cut()
        .build();
    connection.into_transport().send(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn print_raw_escpos(connection: PrinterConnectionConfig, data: Vec<u8>) -> Result<(), String> {
    connection.into_transport().send(&data).map_err(|e| e.to_string())
}

/// P2-34: kicks the cash drawer wired to this printer's drawer port.
/// Deliberately sent directly, never through P2-32's print queue — a
/// drawer kick is a "do it now" hardware action; queuing and retrying it
/// later (possibly minutes after the drawer was actually needed) would
/// make no sense the way a delayed receipt reprint does. `pin` defaults to
/// 0 (almost every real drawer) and the pulse timings to 100ms/200ms
/// (on/off) — safe, commonly-used defaults — when the frontend doesn't
/// need to override them.
#[tauri::command]
pub fn kick_cash_drawer(connection: PrinterConnectionConfig, pin: Option<u8>, on_ms: Option<u16>, off_ms: Option<u16>) -> Result<(), String> {
    let drawer_pin = match pin.unwrap_or(0) {
        0 => DrawerPin::Pin0,
        _ => DrawerPin::Pin1,
    };
    let bytes = ReceiptBuilder::new().kick_drawer(drawer_pin, on_ms.unwrap_or(100), off_ms.unwrap_or(200)).build();
    connection.into_transport().send(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn enqueue_print_job(db_state: State<DbState>, connection: PrinterConnectionConfig, data: Vec<u8>) -> Result<String, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    print_queue::enqueue(conn, &connection, &data).map_err(|e| e.to_string())
}

/// P2-32: a reprint is enqueued as a distinct job whose own bytes carry a
/// "*** COPY ***" banner — see print_queue::enqueue_reprint.
#[tauri::command]
pub fn enqueue_reprint_job(db_state: State<DbState>, connection: PrinterConnectionConfig, data: Vec<u8>) -> Result<String, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    print_queue::enqueue_reprint(conn, &connection, &data).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessQueueSummary {
    pub succeeded: usize,
    pub failed: usize,
    pub dead_lettered: usize,
}

/// Claims due jobs, then sends each one with the database fully unlocked —
/// see print_queue.rs's module docs for why that separation matters (rule
/// 14: a slow or hung printer must never block every other local DB
/// operation in the app, sale-completion included).
#[tauri::command]
pub fn process_print_queue(db_state: State<DbState>) -> Result<ProcessQueueSummary, String> {
    let claimed = {
        let guard = db_state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
        print_queue::claim_due_jobs(conn, 10).map_err(|e| e.to_string())?
    };

    let mut summary = ProcessQueueSummary { succeeded: 0, failed: 0, dead_lettered: 0 };
    for job in claimed {
        let send_result = job.connection.into_transport().send(&job.data);

        let guard = db_state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
        match send_result {
            Ok(()) => {
                print_queue::mark_succeeded(conn, &job.id).map_err(|e| e.to_string())?;
                summary.succeeded += 1;
            }
            Err(err) => {
                print_queue::mark_failed(conn, &job.id, &err.to_string()).map_err(|e| e.to_string())?;
                if job.attempts + 1 >= job.max_attempts {
                    summary.dead_lettered += 1;
                } else {
                    summary.failed += 1;
                }
            }
        }
    }
    Ok(summary)
}

/// P2-32's "failure alerts" surface: a frontend can poll this (same
/// pattern as P1-29's SyncStatusIndicator) and show a banner once
/// dead_letter > 0 rather than silently losing a receipt forever. No actual
/// UI polls it yet — the primitive exists for when one does.
#[tauri::command]
pub fn get_print_queue_status(db_state: State<DbState>) -> Result<QueueStatusSummary, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    print_queue::queue_status(conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_print_jobs(db_state: State<DbState>, status: Option<String>, limit: i64) -> Result<Vec<PrintJobRecord>, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    print_queue::list_jobs(conn, status.as_deref(), limit).map_err(|e| e.to_string())
}
