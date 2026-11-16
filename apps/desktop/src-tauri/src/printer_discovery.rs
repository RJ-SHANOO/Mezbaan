//! P2-35: USB device discovery for the printer setup screen — branch staff
//! pick their printer from a list of what's actually plugged in rather
//! than typing a vendor/product ID by hand, which is the whole point of
//! "without developer help." Network printers need no discovery step at
//! all (the user already knows their printer's IP from its own self-test
//! page), so there's nothing to list for that transport.
use rusb::UsbContext;
use serde::Serialize;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsbDeviceCandidate {
    pub vendor_id: u16,
    pub product_id: u16,
    /// Best-effort — reading a USB string descriptor requires opening the
    /// device, which can fail (permissions, a device that's busy) without
    /// that being a real error for discovery purposes; `None` just means
    /// the setup screen shows the raw vendor/product ID instead of a name.
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

pub fn list_usb_devices() -> Result<Vec<UsbDeviceCandidate>, String> {
    let context = rusb::Context::new().map_err(|e| e.to_string())?;
    let devices = context.devices().map_err(|e| e.to_string())?;

    let mut candidates = Vec::new();
    for device in devices.iter() {
        let Ok(descriptor) = device.device_descriptor() else { continue };
        let (manufacturer, product) = match device.open() {
            Ok(handle) => (
                handle.read_manufacturer_string_ascii(&descriptor).ok(),
                handle.read_product_string_ascii(&descriptor).ok(),
            ),
            Err(_) => (None, None),
        };
        candidates.push(UsbDeviceCandidate { vendor_id: descriptor.vendor_id(), product_id: descriptor.product_id(), manufacturer, product });
    }
    Ok(candidates)
}
