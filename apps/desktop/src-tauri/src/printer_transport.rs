//! P2-31: sending already-built ESC/POS bytes (escpos.rs) to a real printer
//! over USB or the local network. Rule 15 — every hardware/network call here
//! has an explicit timeout; nothing blocks indefinitely. Rule 14 — a
//! printer failure must never block a sale: that guarantee comes from
//! callers never calling `send` synchronously in the sale-completion path
//! without a retry queue in front of it (P2-32), not from anything in this
//! module itself, which is a plain "try once, report the outcome" sender.

use rusb::{Direction, TransferType};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug)]
pub enum PrinterError {
    ConnectionFailed(String),
    Timeout(String),
    Io(String),
    NotFound(String),
}

impl fmt::Display for PrinterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PrinterError::ConnectionFailed(msg) => write!(f, "printer connection failed: {msg}"),
            PrinterError::Timeout(msg) => write!(f, "printer call timed out: {msg}"),
            PrinterError::Io(msg) => write!(f, "printer write failed: {msg}"),
            PrinterError::NotFound(msg) => write!(f, "printer not found: {msg}"),
        }
    }
}

impl std::error::Error for PrinterError {}

pub trait PrinterTransport {
    fn send(&self, data: &[u8]) -> Result<(), PrinterError>;
}

/// A network ESC/POS printer, addressed by host and port (almost always
/// 9100 — the de facto raw-TCP printing port most thermal printers listen
/// on). `timeout` bounds both the connect and the write, since a dead or
/// unreachable printer must fail fast rather than hang a caller forever.
pub struct NetworkPrinter {
    pub host: String,
    pub port: u16,
    pub timeout: Duration,
}

impl PrinterTransport for NetworkPrinter {
    fn send(&self, data: &[u8]) -> Result<(), PrinterError> {
        let addr: SocketAddr = (self.host.as_str(), self.port)
            .to_socket_addrs()
            .map_err(|e| PrinterError::NotFound(format!("{}:{} — {e}", self.host, self.port)))?
            .next()
            .ok_or_else(|| PrinterError::NotFound(format!("{}:{} resolved to no address", self.host, self.port)))?;

        let mut stream = TcpStream::connect_timeout(&addr, self.timeout).map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut {
                PrinterError::Timeout(format!("connecting to {addr}: {e}"))
            } else {
                PrinterError::ConnectionFailed(format!("{addr}: {e}"))
            }
        })?;
        stream.set_write_timeout(Some(self.timeout)).map_err(|e| PrinterError::Io(e.to_string()))?;
        stream.write_all(data).map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut {
                PrinterError::Timeout(format!("writing to {addr}: {e}"))
            } else {
                PrinterError::Io(e.to_string())
            }
        })
    }
}

/// A USB ESC/POS printer, addressed by its USB vendor/product ID — the pair
/// every printer setup screen (P2-35) will ask the user to pick from a
/// detected-device list, not type in by hand.
pub struct UsbPrinter {
    pub vendor_id: u16,
    pub product_id: u16,
    pub timeout: Duration,
}

impl PrinterTransport for UsbPrinter {
    fn send(&self, data: &[u8]) -> Result<(), PrinterError> {
        let handle = rusb::open_device_with_vid_pid(self.vendor_id, self.product_id)
            .ok_or_else(|| PrinterError::NotFound(format!("USB device {:04x}:{:04x}", self.vendor_id, self.product_id)))?;

        // Best-effort: not every platform supports detaching a kernel driver
        // (Windows doesn't need it at all), so a failure here is never fatal.
        let _ = handle.set_auto_detach_kernel_driver(true);

        let out_endpoint = find_bulk_out_endpoint(&handle).ok_or_else(|| PrinterError::NotFound(format!("no bulk OUT endpoint on USB device {:04x}:{:04x}", self.vendor_id, self.product_id)))?;

        handle.claim_interface(out_endpoint.interface).map_err(|e| PrinterError::ConnectionFailed(e.to_string()))?;

        let result = handle.write_bulk(out_endpoint.address, data, self.timeout).map(|_| ()).map_err(|e| match e {
            rusb::Error::Timeout => PrinterError::Timeout(format!("writing to USB device {:04x}:{:04x}", self.vendor_id, self.product_id)),
            other => PrinterError::Io(other.to_string()),
        });

        let _ = handle.release_interface(out_endpoint.interface);
        result
    }
}

struct BulkOutEndpoint {
    interface: u8,
    address: u8,
}

fn find_bulk_out_endpoint(handle: &rusb::DeviceHandle<rusb::GlobalContext>) -> Option<BulkOutEndpoint> {
    let config = handle.device().active_config_descriptor().ok()?;
    for interface in config.interfaces() {
        for descriptor in interface.descriptors() {
            for endpoint in descriptor.endpoint_descriptors() {
                if endpoint.direction() == Direction::Out && endpoint.transfer_type() == TransferType::Bulk {
                    return Some(BulkOutEndpoint { interface: interface.number(), address: endpoint.address() });
                }
            }
        }
    }
    None
}

/// Field names are camelCase on the wire (matching this crate's existing
/// Tauri-boundary convention — see menu_cache.rs's structs) even though the
/// Rust fields themselves are the normal snake_case; `kind`'s own value
/// ("network"/"usb") is lowercase via the enum-level rename_all, set
/// per-variant separately from field casing.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrinterConnectionConfig {
    #[serde(rename_all = "camelCase")]
    Network { host: String, port: u16, timeout_ms: u64 },
    #[serde(rename_all = "camelCase")]
    Usb { vendor_id: u16, product_id: u16, timeout_ms: u64 },
}

impl PrinterConnectionConfig {
    pub fn into_transport(self) -> Box<dyn PrinterTransport> {
        match self {
            PrinterConnectionConfig::Network { host, port, timeout_ms } => Box::new(NetworkPrinter { host, port, timeout: Duration::from_millis(timeout_ms) }),
            PrinterConnectionConfig::Usb { vendor_id, product_id, timeout_ms } => Box::new(UsbPrinter { vendor_id, product_id, timeout: Duration::from_millis(timeout_ms) }),
        }
    }
}
