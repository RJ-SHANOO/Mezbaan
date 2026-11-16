//! P2-31: ESC/POS command building — pure byte-sequence construction, no I/O
//! and no hardware access at all (that's printer_transport.rs). Kept
//! intentionally minimal: just enough to produce a plain text receipt
//! (init, text, bold, align, feed, cut). Configurable templates with logos
//! and tax details (P2-33) and a real print queue (P2-32) build on top of
//! this rather than being part of it.
//!
//! Text is sent as-is in UTF-8 bytes. Most ESC/POS printers expect a
//! single-byte codepage (commonly CP437 or CP1252), not UTF-8 — correct
//! codepage selection/transliteration is a known gap, deferred to P2-33
//! where real receipt content (and therefore real character-set needs)
//! exists. Plain ASCII text round-trips correctly as-is either way.

const ESC: u8 = 0x1B;
const GS: u8 = 0x1D;

/// P2-34: which of the two drawer-kick pins on the printer's cash-drawer
/// port to pulse. Almost every real drawer is wired to pin 0; pin 1 exists
/// for the rarer printer with a second drawer attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawerPin {
    Pin0,
    Pin1,
}

impl DrawerPin {
    fn code(self) -> u8 {
        match self {
            DrawerPin::Pin0 => 0,
            DrawerPin::Pin1 => 1,
        }
    }
}

/// ESC/POS pulse timings are sent as a single byte in ~2ms units, so the
/// real millisecond value this crate's callers think in has to be halved
/// and clamped to what a byte can hold.
fn to_pulse_byte(ms: u16) -> u8 {
    (ms / 2).min(u8::MAX as u16) as u8
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

impl Align {
    fn code(self) -> u8 {
        match self {
            Align::Left => 0,
            Align::Center => 1,
            Align::Right => 2,
        }
    }
}

/// Accumulates raw ESC/POS bytes. `new()` already issues the printer
/// initialize command (ESC @), since every real receipt starts from a known
/// state rather than whatever mode the previous print left the printer in.
#[derive(Default)]
pub struct ReceiptBuilder {
    bytes: Vec<u8>,
}

impl ReceiptBuilder {
    pub fn new() -> Self {
        let mut builder = ReceiptBuilder { bytes: Vec::new() };
        builder.bytes.extend_from_slice(&[ESC, b'@']);
        builder
    }

    pub fn text(mut self, text: &str) -> Self {
        self.bytes.extend_from_slice(text.as_bytes());
        self
    }

    pub fn line(self, text: &str) -> Self {
        self.text(text).text("\n")
    }

    pub fn bold(mut self, on: bool) -> Self {
        self.bytes.extend_from_slice(&[ESC, b'E', if on { 1 } else { 0 }]);
        self
    }

    pub fn align(mut self, mode: Align) -> Self {
        self.bytes.extend_from_slice(&[ESC, b'a', mode.code()]);
        self
    }

    pub fn feed(mut self, lines: u8) -> Self {
        self.bytes.extend_from_slice(&[ESC, b'd', lines]);
        self
    }

    /// GS V 0 — a full cut. Deliberately the only cut mode exposed; a
    /// partial cut isn't needed by anything in this codebase yet.
    pub fn cut(mut self) -> Self {
        self.bytes.extend_from_slice(&[GS, b'V', 0]);
        self
    }

    /// GS v 0 — print a 1-bit monochrome raster image (P2-33's logo
    /// support). `width_bytes` is the image width in bytes (i.e. pixel
    /// width rounded up to a multiple of 8, divided by 8); `bitmap` must be
    /// exactly `width_bytes * height` bytes, MSB-first, 1 = black.
    /// Converting an arbitrary logo file (PNG/JPEG) into this packed format
    /// is the caller's job — no image-decoding dependency exists in this
    /// crate, so that conversion is explicitly out of scope here (see
    /// receipt_template.rs's module docs).
    pub fn raster_image(mut self, width_bytes: u16, height: u16, bitmap: &[u8]) -> Self {
        self.bytes.extend_from_slice(&[GS, b'v', b'0', 0]);
        self.bytes.extend_from_slice(&width_bytes.to_le_bytes());
        self.bytes.extend_from_slice(&height.to_le_bytes());
        self.bytes.extend_from_slice(bitmap);
        self
    }

    /// ESC p m t1 t2 — kick the cash drawer wired to the printer's drawer
    /// port. P2-31 deliberately left this command out (it belongs to
    /// hardware control, not a receipt), and it's this task that adds it.
    /// `on_ms`/`off_ms` are real milliseconds; converted to the spec's raw
    /// ~2ms units internally so callers never have to think in those units.
    pub fn kick_drawer(mut self, pin: DrawerPin, on_ms: u16, off_ms: u16) -> Self {
        self.bytes.extend_from_slice(&[ESC, b'p', pin.code(), to_pulse_byte(on_ms), to_pulse_byte(off_ms)]);
        self
    }

    pub fn build(self) -> Vec<u8> {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_starts_with_the_initialize_command() {
        let bytes = ReceiptBuilder::new().build();
        assert_eq!(bytes, vec![ESC, b'@']);
    }

    #[test]
    fn text_is_appended_as_utf8_bytes() {
        let bytes = ReceiptBuilder::new().text("Hi").build();
        assert_eq!(bytes, vec![ESC, b'@', b'H', b'i']);
    }

    #[test]
    fn line_appends_a_trailing_newline() {
        let bytes = ReceiptBuilder::new().line("Hi").build();
        assert_eq!(bytes, vec![ESC, b'@', b'H', b'i', b'\n']);
    }

    #[test]
    fn bold_on_then_off_emits_both_escape_sequences() {
        let bytes = ReceiptBuilder::new().bold(true).text("x").bold(false).build();
        assert_eq!(bytes, vec![ESC, b'@', ESC, b'E', 1, b'x', ESC, b'E', 0]);
    }

    #[test]
    fn align_emits_the_correct_mode_byte_for_each_variant() {
        assert_eq!(ReceiptBuilder::new().align(Align::Left).build(), vec![ESC, b'@', ESC, b'a', 0]);
        assert_eq!(ReceiptBuilder::new().align(Align::Center).build(), vec![ESC, b'@', ESC, b'a', 1]);
        assert_eq!(ReceiptBuilder::new().align(Align::Right).build(), vec![ESC, b'@', ESC, b'a', 2]);
    }

    #[test]
    fn feed_emits_the_requested_line_count() {
        let bytes = ReceiptBuilder::new().feed(3).build();
        assert_eq!(bytes, vec![ESC, b'@', ESC, b'd', 3]);
    }

    #[test]
    fn raster_image_emits_the_header_then_the_raw_bitmap_bytes() {
        let bitmap = vec![0xFFu8, 0x00u8];
        let bytes = ReceiptBuilder::new().raster_image(1, 2, &bitmap).build();
        let mut expected = vec![ESC, b'@', GS, b'v', b'0', 0];
        expected.extend_from_slice(&1u16.to_le_bytes());
        expected.extend_from_slice(&2u16.to_le_bytes());
        expected.extend_from_slice(&bitmap);
        assert_eq!(bytes, expected);
    }

    #[test]
    fn kick_drawer_converts_milliseconds_to_the_specs_2ms_pulse_units() {
        let bytes = ReceiptBuilder::new().kick_drawer(DrawerPin::Pin0, 100, 200).build();
        assert_eq!(bytes, vec![ESC, b'@', ESC, b'p', 0, 50, 100]);
    }

    #[test]
    fn kick_drawer_selects_pin_one_when_requested() {
        let bytes = ReceiptBuilder::new().kick_drawer(DrawerPin::Pin1, 0, 0).build();
        assert_eq!(bytes, vec![ESC, b'@', ESC, b'p', 1, 0, 0]);
    }

    #[test]
    fn kick_drawer_clamps_an_out_of_range_pulse_to_a_single_byte() {
        let bytes = ReceiptBuilder::new().kick_drawer(DrawerPin::Pin0, 10_000, 10_000).build();
        assert_eq!(bytes, vec![ESC, b'@', ESC, b'p', 0, 255, 255]);
    }

    #[test]
    fn cut_emits_the_full_cut_command() {
        let bytes = ReceiptBuilder::new().cut().build();
        assert_eq!(bytes, vec![ESC, b'@', GS, b'V', 0]);
    }

    #[test]
    fn a_realistic_receipt_builds_in_the_expected_order() {
        let bytes = ReceiptBuilder::new()
            .align(Align::Center)
            .bold(true)
            .line("MEZBAAN")
            .bold(false)
            .align(Align::Left)
            .line("1x Cheeseburger")
            .feed(2)
            .cut()
            .build();

        let mut expected = vec![ESC, b'@'];
        expected.extend_from_slice(&[ESC, b'a', 1]);
        expected.extend_from_slice(&[ESC, b'E', 1]);
        expected.extend_from_slice(b"MEZBAAN\n");
        expected.extend_from_slice(&[ESC, b'E', 0]);
        expected.extend_from_slice(&[ESC, b'a', 0]);
        expected.extend_from_slice(b"1x Cheeseburger\n");
        expected.extend_from_slice(&[ESC, b'd', 2]);
        expected.extend_from_slice(&[GS, b'V', 0]);
        assert_eq!(bytes, expected);
    }
}
