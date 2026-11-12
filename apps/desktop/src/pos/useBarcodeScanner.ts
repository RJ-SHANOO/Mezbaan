import { useEffect, useRef } from "react";

/** A USB barcode scanner types its code as a rapid keystroke burst (well
 * under normal human typing speed) followed by Enter. Below this gap
 * between keystrokes, we treat it as part of a scan; above it, the buffer
 * resets — so ordinary typing (into the search box or anywhere else) never
 * gets mistaken for a scan and is never interfered with (this listener
 * never calls preventDefault). */
const BURST_THRESHOLD_MS = 50;
const MIN_BARCODE_LENGTH = 3;

/**
 * P2-11: listens globally for a barcode-scanner's keystroke burst and calls
 * `onScan` with the accumulated code once Enter arrives, provided the burst
 * was fast enough and long enough to plausibly be a scan rather than a
 * person typing "3" then pausing then hitting Enter on a form.
 */
export function useBarcodeScanner(onScan: (code: string) => void): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let buffer = "";
    let lastKeyTime = 0;

    function handleKeyDown(event: KeyboardEvent): void {
      const now = Date.now();

      if (event.key === "Enter") {
        if (buffer.length >= MIN_BARCODE_LENGTH && now - lastKeyTime <= BURST_THRESHOLD_MS) {
          onScanRef.current(buffer);
        }
        buffer = "";
        return;
      }

      if (event.key.length !== 1) return; // ignore Shift, Ctrl, Arrow keys, etc.

      if (now - lastKeyTime > BURST_THRESHOLD_MS) {
        buffer = ""; // gap too long to be a scan burst — start over
      }
      buffer += event.key;
      lastKeyTime = now;
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
