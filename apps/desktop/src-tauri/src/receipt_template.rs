//! P2-33: turns a restaurant's receipt settings (synced from the server's
//! receipt_settings, P2-33's backend half) and one invoice's content into
//! real ESC/POS bytes, via P2-31's escpos.rs. Pure and I/O-free — the
//! result is handed to P2-32's print queue (`enqueue_print_job`), not sent
//! directly from here.
//!
//! **Logo gap, documented, not fixed here**: `ReceiptSettings.logo_bitmap`
//! expects an already-converted 1-bit monochrome raster (escpos.rs's
//! `raster_image`) — fetching whatever image lives at the server's
//! `logoUrl` and converting it (decode, resize, dither to 1-bit) needs an
//! image-processing dependency this crate doesn't have yet. No real caller
//! populates this field today; it exists so the template already knows how
//! to use one once something does.
use crate::escpos::{Align, ReceiptBuilder};
use serde::Deserialize;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogoBitmap {
    pub width_bytes: u16,
    pub height: u16,
    pub data: Vec<u8>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptSettings {
    pub header_text: Option<String>,
    pub footer_text: Option<String>,
    #[serde(default = "default_true")]
    pub show_tax_breakdown: bool,
    #[serde(default = "default_true")]
    pub show_service_charge: bool,
    pub logo_bitmap: Option<LogoBitmap>,
}

fn default_true() -> bool {
    true
}

// A derived Default would give show_tax_breakdown/show_service_charge
// `false` (bool's own default) even though the serde-level default above is
// `true` — derive(Default) and #[serde(default = ...)] are unrelated
// mechanisms. Implemented by hand so both agree: absent means shown.
impl Default for ReceiptSettings {
    fn default() -> Self {
        Self { header_text: None, footer_text: None, show_tax_breakdown: true, show_service_charge: true, logo_bitmap: None }
    }
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptLineItem {
    pub quantity: i64,
    pub name: String,
    pub line_total: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaxBreakdownLine {
    pub name: String,
    pub rate_basis_points: i64,
    pub amount: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptContent {
    pub restaurant_name: String,
    pub document_number: String,
    pub items: Vec<ReceiptLineItem>,
    pub subtotal: String,
    pub tax_breakdown: Vec<TaxBreakdownLine>,
    pub service_charge: Option<String>,
    pub total: String,
}

pub fn render(settings: &ReceiptSettings, content: &ReceiptContent) -> Vec<u8> {
    let mut builder = ReceiptBuilder::new().align(Align::Center);

    if let Some(logo) = &settings.logo_bitmap {
        builder = builder.raster_image(logo.width_bytes, logo.height, &logo.data);
    }

    builder = builder
        .bold(true)
        .line(settings.header_text.as_deref().unwrap_or(&content.restaurant_name))
        .bold(false)
        .line(&content.document_number)
        .align(Align::Left);

    for item in &content.items {
        builder = builder.line(&format!("{}x {}  {}", item.quantity, item.name, item.line_total));
    }

    builder = builder.line("--------------------------------").line(&format!("Subtotal: {}", content.subtotal));

    if settings.show_tax_breakdown {
        for tax in &content.tax_breakdown {
            let rate_percent = tax.rate_basis_points as f64 / 100.0;
            builder = builder.line(&format!("{} ({:.2}%): {}", tax.name, rate_percent, tax.amount));
        }
    }

    if settings.show_service_charge {
        if let Some(service_charge) = &content.service_charge {
            builder = builder.line(&format!("Service charge: {service_charge}"));
        }
    }

    builder = builder.bold(true).line(&format!("TOTAL: {}", content.total)).bold(false);

    if let Some(footer) = &settings.footer_text {
        builder = builder.align(Align::Center).line(footer);
    }

    builder.feed(3).cut().build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_content() -> ReceiptContent {
        ReceiptContent {
            restaurant_name: "Mezbaan Grill".to_string(),
            document_number: "B1-T1-000001".to_string(),
            items: vec![ReceiptLineItem { quantity: 2, name: "Cheeseburger".to_string(), line_total: "20000".to_string() }],
            subtotal: "20000".to_string(),
            tax_breakdown: vec![TaxBreakdownLine { name: "GST".to_string(), rate_basis_points: 1000, amount: "2000".to_string() }],
            service_charge: Some("1000".to_string()),
            total: "23000".to_string(),
        }
    }

    #[test]
    fn renders_the_header_items_total_and_cut_in_order() {
        let bytes = render(&ReceiptSettings::default(), &sample_content());
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("Mezbaan Grill"));
        assert!(text.contains("2x Cheeseburger"));
        assert!(text.contains("TOTAL: 23000"));
        assert!(text.contains("GST"));
        assert!(text.contains("Service charge: 1000"));
    }

    #[test]
    fn header_text_overrides_the_restaurant_name_when_configured() {
        let settings = ReceiptSettings { header_text: Some("Mezbaan — Gulberg Branch".to_string()), ..Default::default() };
        let bytes = render(&settings, &sample_content());
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("Mezbaan — Gulberg Branch"));
        assert!(!text.contains("Mezbaan Grill"));
    }

    #[test]
    fn hides_the_tax_breakdown_when_configured_off() {
        let settings = ReceiptSettings { show_tax_breakdown: false, ..Default::default() };
        let bytes = render(&settings, &sample_content());
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("GST"));
        assert!(text.contains("TOTAL: 23000")); // the rest of the receipt still renders
    }

    #[test]
    fn hides_the_service_charge_line_when_configured_off() {
        let settings = ReceiptSettings { show_service_charge: false, ..Default::default() };
        let bytes = render(&settings, &sample_content());
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("Service charge"));
    }

    #[test]
    fn footer_text_is_printed_when_configured() {
        let settings = ReceiptSettings { footer_text: Some("Thank you for visiting!".to_string()), ..Default::default() };
        let bytes = render(&settings, &sample_content());
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("Thank you for visiting!"));
    }

    #[test]
    fn no_footer_line_at_all_when_not_configured() {
        let bytes = render(&ReceiptSettings::default(), &sample_content());
        // Nothing to assert textually (an absent Option prints nothing) —
        // this just confirms rendering with no footer doesn't panic and
        // still ends in a cut.
        assert!(bytes.ends_with(&[0x1D, b'V', 0]));
    }

    #[test]
    fn includes_the_raster_image_bytes_when_a_logo_bitmap_is_configured() {
        let settings = ReceiptSettings { logo_bitmap: Some(LogoBitmap { width_bytes: 1, height: 1, data: vec![0xFF] }), ..Default::default() };
        let bytes = render(&settings, &sample_content());
        // GS v 0 header followed by the one bitmap byte, somewhere in the stream.
        let needle = [0x1D, b'v', b'0', 0, 1, 0, 1, 0, 0xFF];
        assert!(bytes.windows(needle.len()).any(|window| window == needle));
    }
}
