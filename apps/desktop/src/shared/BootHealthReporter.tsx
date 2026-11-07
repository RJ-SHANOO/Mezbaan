import { invoke } from "@tauri-apps/api/core";
import { useEffect, type ReactElement } from "react";

/**
 * Fires once this window's initial render commits without the nearest
 * ErrorBoundary catching anything — the "this boot didn't crash" signal behind
 * P1-21's rollback decision (see apps/desktop/src-tauri/src/update_health.rs).
 * Deliberately placed as a sibling of the window's real content, not inside
 * PairingGate: a terminal correctly showing the pairing form is not a failed
 * boot, so this must fire regardless of pairing status. Renders nothing.
 */
export function BootHealthReporter(): ReactElement | null {
  useEffect(() => {
    invoke("confirm_boot_successful").catch((error: unknown) => {
      console.error("confirm_boot_successful failed:", error);
    });
  }, []);
  return null;
}
